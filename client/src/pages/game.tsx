import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { type Game, type TeamDiscussionEntry, type ConsensusVote } from "@shared/schema";
import { useParams } from "wouter";
import { useEffect, useRef, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertCircle, CheckCircle2, XCircle, Clock, Timer, Bot } from "lucide-react";
import { SiOpenai, SiAnthropic, SiGooglegemini } from "react-icons/si";
import { storage } from "@/lib/storage";

// Update AI model display info with correct icon components
const AI_MODEL_INFO = {
  "gpt-4o": { name: "GPT-4", Icon: SiOpenai },
  "claude-3-5-sonnet-20241022": { name: "Claude", Icon: SiAnthropic },
  "grok-2-1212": { name: "Grok", Icon: Bot },
  "gemini-1.5-pro": { name: "Gemini", Icon: SiGooglegemini }
} as const;

type AIModel = keyof typeof AI_MODEL_INFO;

type GameLogEntry = {
  team: string;
  action: string;
  result: "correct" | "wrong" | "assassin" | "pending";
  word?: string;
  player?: string;
  timestamp?: number;
  reasoning?: string;
};

const getModelDisplayName = (model: AIModel): string => {
  return AI_MODEL_INFO[model]?.name || model;
}

export default function GamePage() {
  const { id } = useParams();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  // Refs
  const aiTurnInProgress = useRef(false);
  const processedGameState = useRef<string | false>(false);
  const aiDiscussionTriggered = useRef(false);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();
  
  // State hooks - must be in the same order every render
  const [isSpymasterView, setIsSpymasterView] = useState(false);
  const [gameLog, setGameLog] = useState<GameLogEntry[]>([]);
  const [turnTimer, setTurnTimer] = useState<number>(60);
  const [discussionTimer, setDiscussionTimer] = useState<number>(60);
  const [isDiscussing, setIsDiscussing] = useState(false);
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.7);
  const [votingInProgress, setVotingInProgress] = useState(false);
  const [lastClue, setLastClue] = useState<{ word: string; number: number } | null>(null);
  const [discussionInput, setDiscussionInput] = useState("");

  // Query hook
  const { data: game, isLoading, isError } = useQuery<Game>({
    queryKey: [`/api/games/${id}`],
    refetchInterval: 1000,
    refetchIntervalInBackground: true
  });

  // All useEffect hooks - must be defined before any conditional returns
  // WebSocket connection
  useEffect(() => {
    if (!id) return;

    const connectWebSocket = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      const socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        console.log('WebSocket connected');
        const currentTeam = game?.currentTurn === "red_turn" ? "red" : "blue";
        socket.send(JSON.stringify({
          type: 'join',
          gameId: Number(id),
          team: currentTeam
        }));
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('Received WebSocket message:', data);

          if (data.type === 'discussion') {
            // Immediately update local state
              setGameLog(prev => [...prev, {
                team: data.team,
                action: data.content,
                result: "pending",
              player: data.player,
              timestamp: data.timestamp
            }]);

            // Force refresh of game data
            queryClient.invalidateQueries({ 
              queryKey: [`/api/games/${id}`],
              refetchType: 'active',
              exact: true
            });
          }

          if (data.type === 'guess') {
            const guessResult = data.result; // "correct", "wrong", or "assassin"
            
            // Immediately update game log
            setGameLog(prev => [...prev, {
              team: data.team,
              action: `Guessed: ${data.word}`,
              result: guessResult,
              word: data.word,
              player: data.player,
              timestamp: data.timestamp
            }]);

            // Force immediate game data refresh
            queryClient.invalidateQueries({ 
              queryKey: [`/api/games/${id}`],
              refetchType: 'active',
              exact: true
            });

            // Reset state if turn ends
            if (guessResult === 'wrong' || guessResult === 'assassin') {
              setLastClue(null);
              setIsDiscussing(false);
              aiTurnInProgress.current = false;
            }
          }

          if (data.type === 'clue') {
            queryClient.invalidateQueries({ 
              queryKey: [`/api/games/${id}`],
              refetchType: 'active',
              exact: true
            });
          }
        } catch (error) {
          console.error('Error processing WebSocket message:', error);
        }
      };

      socket.onclose = () => {
        console.log('WebSocket disconnected. Attempting to reconnect...');
        setTimeout(connectWebSocket, 3000);
      };

      socket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      socketRef.current = socket;
    };

    connectWebSocket();

    return () => {
      if (socketRef.current) {
        socketRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [id]);

  // Game state processor effect
  useEffect(() => {
    if (!game || !id) return;
    
    // Prevent processing if game state is already being processed
    if (aiTurnInProgress.current) return;
    
    // Only process the game state once per turn
    const turnKey = `${game.currentTurn}-${lastClue ? 'hasClue' : 'noClue'}`;
    if (processedGameState.current === turnKey) return;
    
    // Safe version of processGameState that doesn't cause infinite loops
    const safeProcessGameState = () => {
      try {
        // AI spymaster's turn to give a clue
        if (isSpymasterAI && !lastClue && !game.gameState?.includes("win")) {
          console.log("AI spymaster's turn to give a clue");
          aiTurnInProgress.current = true;
          getAIClue.mutate();
          processedGameState.current = turnKey;
          return;
        }
        
        // AI operatives turn to discuss and make guesses
        if (lastClue && !isDiscussing && !aiDiscussionTriggered.current && !game.gameState?.includes("win")) {
          console.log("Starting team discussion for clue:", lastClue);
          setIsDiscussing(true);
          setDiscussionTimer(60);
          aiDiscussionTriggered.current = true;
          processedGameState.current = turnKey;
          return;
        }
      } catch (err) {
        console.error("Error processing game state:", err);
        aiTurnInProgress.current = false;
      }
    };
    
    // Execute safely
    safeProcessGameState();
  }, [game, lastClue, id, isDiscussing]);

  // Reset discussion trigger effect
  useEffect(() => {
    if (!lastClue) {
      aiDiscussionTriggered.current = false;
    }
  }, [lastClue]);

  // All mutation hooks - define all of them before conditional returns
  const switchTurns = useMutation({
    mutationFn: async () => {
      if (!game) return null;
      
      const nextTurn = game.currentTurn === "red_turn" ? "blue_turn" : "red_turn";
      const res = await apiRequest("PATCH", `/api/games/${id}`, {
        currentTurn: nextTurn
      });
      
      return res.json();
    },
    onSuccess: () => {
      setLastClue(null);
      setIsDiscussing(false);
      aiTurnInProgress.current = false;
      aiDiscussionTriggered.current = false;
      processedGameState.current = false;
      queryClient.invalidateQueries({ queryKey: [`/api/games/${id}`] });
    }
  });

  const getAIClue = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/games/${id}/ai/clue`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      console.log("AI clue received with reasoning:", data);
      setLastClue(data);
      
      // Add clue to game log with reasoning
      if (game) {
        const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";
        const spymaster = game.currentTurn === "red_turn" ? game.redSpymaster : game.blueSpymaster;
        
        setGameLog(prev => [...prev, {
          team: currentTeam,
          action: `Spymaster gives clue: ${data.word} (${data.number})`,
          result: "pending",
          player: spymaster,
          timestamp: Date.now(),
          reasoning: data.reasoning
        }]);
      }
      
      aiTurnInProgress.current = false;
    },
    onError: (error: Error) => {
      toast({
        title: "Error getting AI clue",
        description: error.message,
        variant: "destructive",
      });
      aiTurnInProgress.current = false;
      setIsDiscussing(false);
    },
  });

  const discussMove = useMutation({
    mutationFn: async (params: { model: AIModel; team: "red" | "blue"; clue: any }) => {
      console.log("Sending discuss request:", params);
      const res = await apiRequest("POST", `/api/games/${id}/ai/discuss`, params);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (response) => {
      console.log("Discussion response received:", response);
      
      // Update local game log immediately (don't wait for WebSocket)
      if (response) {
        setGameLog(prev => [...prev, {
          team: response.team,
          action: response.message,
          result: "pending",
          player: response.player,
          timestamp: response.timestamp || Date.now()
        }]);
      }
      
      // Force refresh of game data
      queryClient.invalidateQueries({ 
        queryKey: [`/api/games/${id}`],
        refetchType: 'active',
        exact: true
      });
    },
    onError: (error: Error) => {
      console.error("Discussion API error:", error);
      toast({
        title: "Error in AI discussion",
        description: error.message,
        variant: "destructive",
      });
    }
  });

  const voteOnWord = useMutation({
    mutationFn: async (params: { model: AIModel; team: "red" | "blue"; word: string }) => {
      const res = await apiRequest("POST", `/api/games/${id}/ai/vote`, params);
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      // If all votes are in and approved, make the guess
      if (data.allVoted && data.allApproved) {
        await makeGuess.mutateAsync(params.word);
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/games/${id}`] });
    }
  });

  // 1. Fix the timer expiration effect to forcefully change turns
  useEffect(() => {
    // Only execute when the timer reaches zero and there's an active game
    if (!game || turnTimer !== 0 || game.gameState?.includes("win")) return;
    
    console.log("TIMER EXPIRED - Forcing turn change");
    const isRedTurn = game.currentTurn === "red_turn";
    const nextTurn = isRedTurn ? "blue_turn" : "red_turn";
    
    // Make a dedicated API call with clear parameters
    apiRequest("PATCH", `/api/games/${id}`, {
      currentTurn: nextTurn,
      _forceTimerSwitch: true, // Signal this is from timer expiration
      _timestamp: Date.now()
    })
    .then(res => res.json())
    .then(data => {
      // Log success or failure
      if (data.error) {
        console.error("Turn switch failed:", data.error);
      } else {
        console.log("Turn switched successfully via timer");
        
        // Reset all relevant state
        setLastClue(null);
        setIsDiscussing(false);
        setTurnTimer(60); // Reset timer for next turn
        aiTurnInProgress.current = false;
        processedGameState.current = false;
        
        // Explicitly invalidate to refresh UI
        queryClient.invalidateQueries({ queryKey: [`/api/games/${id}`] });
      }
    })
    .catch(err => console.error("Error in timer-based turn switch:", err));
  }, [turnTimer, game?.id, game?.currentTurn, game?.gameState]);

  // 2. Make the makeGuess function more robust
  const makeGuess = useMutation({
    mutationFn: async (word: string) => {
      if (!game) return null;

      // Check if the card is already revealed
      if (game.revealedCards.includes(word)) {
        toast({
          title: "Invalid move",
          description: "This word has already been revealed",
          variant: "destructive",
        });
        return null;
      }

      // First, reveal the card
      const res = await apiRequest("PATCH", `/api/games/${id}`, {
        revealedCards: [...(game?.revealedCards || []), word],
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);
      
      // Determine the type of word guessed
      const isRedTurn = game.currentTurn === "red_turn";
      const isAssassin = word === game.assassin;
      const isRedTeamWord = game.redTeam.includes(word);
      const isBlueTeamWord = game.blueTeam.includes(word);
      const isCorrectTeamWord = isRedTurn ? isRedTeamWord : isBlueTeamWord;
      const isOpponentTeamWord = isRedTurn ? isBlueTeamWord : isRedTeamWord;
      const isNeutralWord = !isRedTeamWord && !isBlueTeamWord && !isAssassin;
      
      // Log for debugging
      console.log(`GUESS: ${word} | Team: ${isRedTurn ? 'Red' : 'Blue'} | Type: ${
        isCorrectTeamWord ? 'Correct' : 
        isOpponentTeamWord ? 'Opponent' : 
        isAssassin ? 'Assassin' : 'Neutral'
      }`);
      
      // Add to game log
      const result = isCorrectTeamWord ? "correct" : 
                    isAssassin ? "assassin" : 
                    isOpponentTeamWord ? "wrong" : "pending";
      
      setGameLog(prev => [...prev, {
        team: isRedTurn ? "red" : "blue",
        action: `Guessed: ${word}`,
        result,
        word,
        player: "human",
        timestamp: Date.now()
      }]);
      
      // Switch turns if needed (opponent's word, neutral, or assassin)
      if (isOpponentTeamWord || isNeutralWord || isAssassin) {
        console.log(`FORCING TURN SWITCH: ${
          isAssassin ? 'Assassin' : isOpponentTeamWord ? 'Opponent word' : 'Neutral word'
        } guessed`);
        
        const nextTurn = isRedTurn ? "blue_turn" : "red_turn";
        
        // Second API call specifically for switching turns
        try {
          const switchResponse = await fetch(`/api/games/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              currentTurn: nextTurn,
              _forceGuessSwitch: true,
              wordGuessed: word,
              wordType: isAssassin ? 'assassin' : isOpponentTeamWord ? 'opponent' : 'neutral',
              _timestamp: Date.now()
            })
          });
          
          const switchData = await switchResponse.json();
          console.log("Turn switch response:", switchData);
          
          // Reset state for new turn
          setLastClue(null);
          setIsDiscussing(false);
          setTurnTimer(60); // Reset timer for next turn
          aiTurnInProgress.current = false;
          processedGameState.current = false;
        } catch (err) {
          console.error("Error switching turns:", err);
        }
      }
      
      return data;
    },
    
    onSuccess: () => {
      // Force refresh game data
      queryClient.invalidateQueries({ queryKey: [`/api/games/${id}`] });
    }
  });

  // 1. Fix the timer effect to ACTUALLY decrease the timer
  useEffect(() => {
    if (!game || game.gameState?.includes("win")) return;
    
    console.log("Setting up turn timer");
    const timerInterval = setInterval(() => {
      setTurnTimer(prev => {
        const newValue = prev > 0 ? prev - 1 : 0;
        console.log(`Turn timer: ${prev} -> ${newValue}`);
        return newValue;
      });
    }, 1000);
    
    return () => clearInterval(timerInterval);
  }, [game?.id]); // Only change when game changes, not on every state change

  // All helper functions - define these after all hooks
  const processGameState = () => {
    if (!game || !id) return;
    
    const isRedTurn = game.currentTurn === "red_turn";
    const currentTeam = isRedTurn ? "red" : "blue";
    const spymaster = isRedTurn ? game.redSpymaster : game.blueSpymaster;
    const currentPlayers = isRedTurn ? game.redPlayers : game.bluePlayers;
    
    console.log("Processing game state:", {
      turn: game.currentTurn,
      spymaster,
      hasClue: !!lastClue
    });
    
    // Check if it's an AI spymaster's turn to give a clue
    if (spymaster !== "human" && !lastClue && !aiTurnInProgress.current) {
      console.log(`AI Spymaster (${spymaster}) should give a clue`);
      aiTurnInProgress.current = true;
      
      // Use setTimeout to break dependency cycle
      setTimeout(() => {
        getAIClue.mutate();
      }, 1000);
      return;
    }
    
    // Check if AI teammates should discuss a clue
    if (lastClue && !aiDiscussionTriggered.current) {
      const aiTeammates = currentPlayers.filter(p => 
        p !== "human" && p !== spymaster
      ) as AIModel[];
      
      if (aiTeammates.length > 0) {
        console.log("AI teammates should discuss:", aiTeammates);
        aiDiscussionTriggered.current = true;
        setIsDiscussing(true);
        
        // Use separate timeouts for each AI to discuss
        aiTeammates.forEach((model, index) => {
          setTimeout(() => {
            // Use direct API call to avoid dependency issues
            fetch(`/api/games/${id}/ai/discuss`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model,
                team: currentTeam,
                clue: lastClue
              })
            })
            .then(res => res.json())
            .then(data => {
              if (data.message) {
                // Update game log
              setGameLog(prev => [...prev, {
                  team: data.team,
                  action: data.message,
                result: "pending",
                  player: data.player,
                  timestamp: Date.now()
                }]);
                
                // Refresh game data
                queryClient.invalidateQueries({ 
                  queryKey: [`/api/games/${id}`],
                  refetchType: 'active',
                  exact: true
                });
              }
            })
            .catch(error => {
              console.error("Discussion API error:", error);
            });
          }, index * 1500 + 500);
        });
      }
    }
  };

  const sendDiscussion = () => {
    if (!discussionInput.trim() || !game) return;
    
    const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";
    
    // Send discussion message via WebSocket
              if (socketRef.current?.readyState === WebSocket.OPEN) {
                socketRef.current.send(JSON.stringify({
                  type: 'discussion',
        content: discussionInput,
                  team: currentTeam,
        player: 'human',
        gameId: Number(id),
                  timestamp: Date.now()
                }));
    }
    
    // Add to local game log
        setGameLog(prev => [...prev, {
          team: currentTeam,
      action: discussionInput,
      result: "pending",
      player: 'human',
      timestamp: Date.now()
    }]);
    
    // Clear input
    setDiscussionInput("");
    
    // Also update the game state
    if (game.teamDiscussion) {
      const newDiscussion = [...game.teamDiscussion, {
            team: currentTeam,
        player: 'human',
        message: discussionInput,
        timestamp: Date.now()
      }];
      apiRequest("PATCH", `/api/games/${id}`, { teamDiscussion: newDiscussion });
    }
  };

  const getCardColor = (word: string): string => {
    if (!game) return "bg-white";
    
    if (isSpymasterView || game.revealedCards.includes(word)) {
      if (game.redTeam.includes(word)) return "bg-red-500";
      if (game.blueTeam.includes(word)) return "bg-blue-500";
      if (game.assassin === word) return "bg-gray-800";
      return "bg-neutral-200";
    }
    return "bg-white hover:bg-gray-50";
  };

  const getTextColor = (word: string): string => {
    if (isSpymasterView) {
      if (game.assassin === word) return "text-white";
      return game.revealedCards.includes(word) ? "text-white" : "text-black";
    }
    return game.revealedCards.includes(word) ? "text-white" : "text-gray-900";
  };

  // Add these missing functions after your other helper functions
  const renderTeamDiscussion = () => {
    if (!game) return null;
    
    const teamDiscussion = game.teamDiscussion || [];
    const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";

    // Extract voting-related messages
    const votingMessages = teamDiscussion.filter(entry => 
      entry.isVoting === true || entry.voteType
    );
    
    // Get the most recent voting entry if it exists
    const activeVote = votingMessages.length > 0 
      ? votingMessages[votingMessages.length - 1] 
      : null;
    
    const suggestedWord = activeVote?.suggestedWord || activeVote?.suggestedWords?.[0];
    
    return (
      <Card className="h-[400px] overflow-hidden flex flex-col">
        <CardContent className="flex-1 p-4 flex flex-col h-full">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-bold text-lg">Team Discussion</h3>
            {isDiscussing && (
              <div className="flex items-center text-amber-600">
                <Clock className="w-4 h-4 mr-1" />
                <span>{discussionTimer}s</span>
              </div>
            )}
          </div>
          
          {/* Voting UI */}
          {activeVote && currentTeam === activeVote.team && (
            <div className="bg-amber-50 border border-amber-200 rounded-md p-3 mb-4">
              <div className="font-medium mb-2">
                {activeVote.voteType === "continue" 
                  ? "Vote to continue guessing?" 
                  : "Should we end our turn?"}
              </div>
              
              {suggestedWord && (
                <div className="flex items-center mb-2">
                  <span className="mr-2">Suggested word:</span>
                  <span className="font-semibold bg-white px-2 py-1 rounded border">{suggestedWord}</span>
                </div>
              )}
              
              <div className="flex space-x-2 mt-3">
                <Button 
                  size="sm" 
                  variant="default"
                  className="bg-green-600 hover:bg-green-700"
                  onClick={() => submitVote(activeVote.voteType === "continue" ? "continue" : "end_turn", true)}
                >
                  Yes
                </Button>
                <Button 
                  size="sm" 
                  variant="outline"
                  onClick={() => submitVote(activeVote.voteType === "continue" ? "end_turn" : "continue", false)}
                >
                  No
                </Button>
              </div>
            </div>
          )}
          
          {/* Chat messages */}
          <ScrollArea className="pr-4 flex-1">
            <div className="space-y-4 pb-4">
              {teamDiscussion
                .filter(entry => entry.team === currentTeam && !entry.isVoting)
                .map((entry, index) => {
                  const isAI = entry.player !== 'Game' && entry.player !== 'human';
                  const ModelIcon = isAI && AI_MODEL_INFO[entry.player as AIModel]?.Icon 
                    ? AI_MODEL_INFO[entry.player as AIModel]?.Icon 
                    : Bot;
                  
                  return (
                    <div key={index} className="flex items-start gap-2">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center">
                        {isAI ? (
                          <ModelIcon className={`w-5 h-5 ${entry.player === "gemini-1.5-pro" ? "text-green-600" : ""}`} />
                        ) : (
                          entry.player === 'Game' ? 
                            <Clock className="w-5 h-5 text-gray-500" /> : 
                            <span className="text-sm">👤</span>
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="font-medium">
                          {isAI ? getModelDisplayName(entry.player as AIModel) : entry.player}
                        </div>
                        <div>{entry.message}</div>
                      </div>
                    </div>
                  );
                })}
            </div>
          </ScrollArea>
          
          {/* Input field for human players */}
          {currentTeam === (game.redTurn ? "red" : "blue") && (
            <div className="mt-4 flex gap-2">
              <input
                type="text"
                value={discussionInput}
                onChange={(e) => setDiscussionInput(e.target.value)}
                placeholder="Type your thoughts..."
                className="flex-1 border rounded px-3 py-2"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && discussionInput.trim()) {
                    sendDiscussionMessage.mutate({});
                  }
                }}
              />
              <Button 
                onClick={() => sendDiscussionMessage.mutate({})}
                disabled={!discussionInput.trim()}
              >
                Send
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  const renderGameLog = () => {
    // Only include important game events (clues and guesses)
    const filteredLog = gameLog.filter(entry => 
      // Add null checks to prevent accessing properties of undefined
      (entry.action && (
        entry.action.includes("clue") || 
        entry.action.includes("Guessed")
      )) ||
      entry.result === "correct" ||
      entry.result === "wrong" ||
      entry.result === "assassin"
    );
    
    if (filteredLog.length === 0) {
      return (
        <div className="text-center p-6 text-gray-500">
          <div className="mb-2">📜</div>
          No game actions yet
        </div>
      );
    }

    return (
      <ScrollArea className="h-[400px]">
        <div className="space-y-2 p-2">
          {filteredLog.slice().reverse().map((entry, i) => {
            const isRed = entry.team === "red";
            const isClue = entry.action.includes("clue");
            const hasReasoning = entry.reasoning && typeof entry.reasoning === 'string';

            return (
              <div
                key={i} 
                className={`p-3 rounded-lg border-l-4 ${
                  isRed 
                    ? "bg-red-50 border-red-500" 
                    : "bg-blue-50 border-blue-500"
                } shadow-sm flex items-start gap-3 hover:shadow-md transition-shadow`}
              >
                <div className="mt-1">
                  {isClue 
                    ? <span className="text-xl">🔍</span>
                    : getLogEmoji(entry.result)
                  }
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`font-semibold ${isRed ? "text-red-700" : "text-blue-700"}`}>
                      {isRed ? "Red" : "Blue"}
                  </span>
                    {entry.player && (
                      <span className="text-xs bg-gray-100 px-2 py-0.5 rounded-full">
                        {entry.player === "human" ? "You" : entry.player}
                      </span>
                    )}
                    <span className="text-xs text-gray-500 ml-auto">
                      {entry.timestamp 
                        ? new Date(entry.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
                        : new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                    </span>
                  </div>
                  <p className={`text-gray-800 ${isClue ? "font-medium" : ""}`}>
                    {entry.action}
                  </p>
                  {entry.word && (
                    <div className="mt-1">
                      <span className={`inline-block px-2 py-1 text-xs rounded ${
                        entry.result === "correct" 
                          ? "bg-green-100 text-green-800" 
                          : entry.result === "wrong" 
                            ? "bg-red-100 text-red-800" 
                            : "bg-gray-100 text-gray-800"
                      }`}>
                        {entry.word}
                      </span>
                    </div>
                  )}
                  
                  {/* Display reasoning only for human players (not for AI) */}
                  {hasReasoning && (
                    <div className="mt-2 p-2 bg-purple-100 border-l-4 border-purple-500 text-purple-800 text-sm rounded">
                      <p className="font-semibold mb-1">Spymaster's Reasoning:</p>
                      <p>{entry.reasoning}</p>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    );
  };

  // Add this helper function to get appropriate emoji for log entries
  const getLogEmoji = (result: "correct" | "wrong" | "assassin" | "pending") => {
    switch (result) {
      case "correct":
        return <CheckCircle2 className="text-green-500 w-5 h-5" />;
      case "wrong":
        return <XCircle className="text-red-500 w-5 h-5" />;
      case "assassin":
        return <AlertCircle className="text-black w-5 h-5" />;
      case "pending":
      default:
        return <Clock className="text-gray-400 w-5 h-5" />;
    }
  };

  // Add the vote submission function
  const submitVote = (action: "continue" | "end_turn", isAgree: boolean) => {
    if (!game) return;
    
    const vote = {
      model: "human", 
      team: game.currentTurn === "red_turn" ? "red" : "blue",
      action: isAgree ? action : (action === "continue" ? "end_turn" : "continue")
    };
    
    // Use your existing mutation to send the vote
    apiRequest(`/api/games/${game.id}/meta/vote`, {
      method: 'POST',
      body: JSON.stringify(vote)
    })
    .then(response => {
      toast({
        title: "Vote submitted",
        description: `You voted to ${isAgree ? action : (action === "continue" ? "end_turn" : "continue")} the turn`,
      });
    })
    .catch(error => {
      toast({
        title: "Failed to submit vote",
        description: error.message,
        variant: "destructive"
      });
    });
  };

  // IMPORTANT: After all hooks are defined, then do conditional rendering
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xl">Loading game...</div>
      </div>
    );
  }

  if (isError || !game) {
            return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="text-xl text-red-500">Error loading game</div>
          <Button onClick={() => window.location.href = "/"}>
            Return to Home
          </Button>
                </div>
              </div>
            );
  }

  // Now we can safely access game data knowing it exists
  const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";
  const isRedTurn = game.currentTurn === "red_turn";
  const spymaster = isRedTurn ? game.redSpymaster : game.blueSpymaster;
  const capitalizedTeam = isRedTurn ? "Red" : "Blue";
  const isSpymasterAI = spymaster !== "human";

  // Main component render
  return (
    <div className="min-h-screen bg-neutral-50 p-4">
      <div className="mb-6 text-center">
        <h1 className="text-3xl font-bold mb-3">Codenames AI</h1>

        <div className="flex justify-center items-center gap-6 mb-3">
          <div className="text-red-500 font-bold text-xl">Red: {game.redScore}</div>
          <div className={`px-6 py-2 rounded-full font-semibold ${
            isRedTurn ? "bg-red-100 text-red-700" : "bg-blue-100 text-blue-700"
          }`}>
            {capitalizedTeam}'s Turn
          </div>
          <div className="text-blue-500 font-bold text-xl">Blue: {game.blueScore}</div>
        </div>

        <div className="flex items-center justify-center gap-4 mb-3">
          <div className="flex items-center gap-2">
            <Timer className="w-4 h-4" />
            <span className={`font-medium ${turnTimer <= 10 ? 'text-red-500' : ''}`}>
              Turn: {turnTimer}s
            </span>
          </div>
            <div className="flex items-center gap-2">
          <Switch
            checked={isSpymasterView}
            onCheckedChange={setIsSpymasterView}
          />
          <span className="font-medium">Spymaster View</span>
          </div>
        </div>
      </div>

      {/* Update layout with even more space for the game board */}
      <div className="max-w-[1900px] mx-auto grid grid-cols-1 lg:grid-cols-7 gap-6">
        {/* Larger game board taking 5 columns */}
        <div className="lg:col-span-5">
          <div className="grid grid-cols-5 gap-5">
          {game.words.map((word) => (
            <Card
              key={word}
                className={`${getCardColor(word)} cursor-pointer transition-all hover:scale-105 h-40 flex items-center justify-center shadow-md`}
              onClick={() => {
                  if (!game.revealedCards.includes(word) && !game.gameState?.includes("win") && !aiTurnInProgress.current) {
                  makeGuess.mutate(word);
                }
              }}
            >
                <CardContent className="p-8 text-center flex items-center justify-center h-full w-full">
                  <span className={`font-medium text-3xl ${getTextColor(word)}`}>
                  {word}
                </span>
              </CardContent>
            </Card>
          ))}
          </div>
        </div>

        {/* Sidebar for discussion and log taking 2 columns */}
        <div className="lg:col-span-2 space-y-6">
          {renderTeamDiscussion()}
          <Card>
            <CardContent className="p-4">
              <h3 className="font-bold text-lg mb-4">Game Log</h3>
              {renderGameLog()}
            </CardContent>
          </Card>
        </div>
      </div>

      {game.gameState?.includes("win") && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center">
          <Card className="w-96">
            <CardContent className="p-6 text-center">
              <h2 className="text-2xl font-bold mb-4">
                {game.gameState === "red_win" ? "Red Team Wins!" : "Blue Team Wins!"}
              </h2>
              <Button
                className="w-full"
                onClick={() => window.location.href = "/"}
              >
                Play Again
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}