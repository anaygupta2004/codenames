import { useQuery, useMutation } from "@tanstack/react-query";
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
  "gemini-pro": { name: "Gemini", Icon: SiGooglegemini }
} as const;

type AIModel = keyof typeof AI_MODEL_INFO;

type GameLogEntry = {
  team: string;
  action: string;
  result: "correct" | "wrong" | "assassin" | "pending";
  word?: string;
  player?: string;
};

export default function GamePage() {
  const { id } = useParams();
  const { toast } = useToast();
  const aiTurnInProgress = useRef(false);
  const [isSpymasterView, setIsSpymasterView] = useState(false);
  const [gameLog, setGameLog] = useState<GameLogEntry[]>([]);
  const [turnTimer, setTurnTimer] = useState<number>(60); // 60 seconds per turn
  const [discussionTimer, setDiscussionTimer] = useState<number>(20); // 20 seconds for discussion
  const [isDiscussing, setIsDiscussing] = useState(false);
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.8);
  const [votingInProgress, setVotingInProgress] = useState(false);
  const timerRef = useRef<NodeJS.Timeout>();
  const [lastClue, setLastClue] = useState<{ word: string; number: number } | null>(null);

  const { data: game, isLoading } = useQuery<Game>({
    queryKey: [`/api/games/${id}`],
  });

  // Update the getAIClue mutation with better error handling
  const getAIClue = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/games/${id}/ai/clue`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setLastClue(data);
      return data;
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
      const res = await apiRequest("POST", `/api/games/${id}/ai/discuss`, params);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/games/${id}`] });
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

  const makeGuess = useMutation({
    mutationFn: async (word: string) => {
      if (!game) return null;

      if (game.revealedCards.includes(word)) {
        toast({
          title: "Invalid move",
          description: "This word has already been revealed",
          variant: "destructive",
        });
        return null;
      }

      const res = await apiRequest("PATCH", `/api/games/${id}`, {
        revealedCards: [...(game?.revealedCards || []), word],
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (response) => {
      if (!response) return;

      queryClient.invalidateQueries({ queryKey: [`/api/games/${id}`] });
      aiTurnInProgress.current = false;
      setLastClue(null);
      setIsDiscussing(false);
    },
    onError: (error: any) => {
      toast({
        title: "Error making guess",
        description: error.message,
        variant: "destructive",
      });
      setIsDiscussing(false);
      aiTurnInProgress.current = false;
    }
  });

  // Updated handleAITurn to manage faster discussions
  const handleAITurn = async () => {
    try {
      if (aiTurnInProgress.current || !game) return;
      aiTurnInProgress.current = true;

      // Get current team configuration
      const isRedTeam = game.currentTurn === "red_turn";
      const currentTeam = isRedTeam ? "red" : "blue";
      const currentSpymaster = isRedTeam ? game.redSpymaster : game.blueSpymaster;
      const currentTeamPlayers = isRedTeam ? game.redPlayers : game.bluePlayers;

      // 1. Get clue from spymaster if needed
      if (!lastClue) {
        try {
          const clue = await getAIClue.mutateAsync();
          setLastClue(clue);

          if (currentSpymaster && typeof currentSpymaster === 'string') {
            setGameLog(prev => [...prev, {
              team: currentTeam,
              action: `gives clue: "${clue.word} (${clue.number})"`,
              result: "pending",
              player: currentSpymaster
            }]);
          }
        } catch (error) {
          console.error("Error getting clue:", error);
          return;
        }
      }

      if (!lastClue) return;

      // 2. Start team discussion with shorter timer
      setIsDiscussing(true);
      setDiscussionTimer(60); // 60 seconds for discussion

      // Get AI operatives (excluding spymaster)
      const aiOperatives = currentTeamPlayers.filter(
        player => typeof player === 'string' &&
          player !== 'human' &&
          player !== currentSpymaster
      ) as AIModel[];

      // 3. Have each AI operative discuss the clue with Promise.all for parallel execution
      const discussionPromises = aiOperatives.map(aiOperative =>
        discussMove.mutateAsync({
          model: aiOperative,
          team: currentTeam,
          clue: lastClue
        })
      );

      await Promise.all(discussionPromises);

      // 4. Immediately start voting process after discussions
      const currentTeamDiscussion = game.teamDiscussion as TeamDiscussionEntry[];

      // Find the most confident suggestion
      const suggestions = currentTeamDiscussion
        .filter(entry => entry.team === currentTeam && entry.suggestedWord)
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

      if (suggestions.length > 0 && (suggestions[0].confidence || 0) > confidenceThreshold) {
        // All AI operatives vote on the most confident suggestion
        const votePromises = aiOperatives.map(aiOperative =>
          voteOnWord.mutateAsync({
            model: aiOperative,
            team: currentTeam,
            word: suggestions[0].suggestedWord!
          })
        );

        await Promise.all(votePromises);
      } else {
        // If no confident suggestions, skip the turn
        await switchTurns();
      }
    } catch (error) {
      console.error("Error in AI turn:", error);
      aiTurnInProgress.current = false;
      setIsDiscussing(false);
      await switchTurns();
    }
  };

  useEffect(() => {
    if (!game || game.gameState?.includes("win") || aiTurnInProgress.current) return;

    const isRedTurn = game.currentTurn === "red_turn";
    const currentSpymaster = isRedTurn ? game.redSpymaster : game.blueSpymaster;
    const currentTeam = isRedTurn ? game.redPlayers : game.bluePlayers;

    // If it's AI's turn and not discussing yet, start the process
    if (currentSpymaster && !isDiscussing && !lastClue) {
      handleAITurn();
    }
  }, [game?.currentTurn, isDiscussing, lastClue]);

  // Handle turn timer
  useEffect(() => {
    if (!game || game.gameState?.includes("win")) return;

    // Start turn timer
    const interval = setInterval(() => {
      setTurnTimer((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          handleTimeUp();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [game?.currentTurn]);

  // Update effect for discussion timer to be more aggressive
  useEffect(() => {
    if (!isDiscussing) return;

    const interval = setInterval(() => {
      setDiscussionTimer((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          handleDiscussionTimeUp();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    // Force discussion to end after 20 seconds
    const discussionTimeout = setTimeout(() => {
      handleDiscussionTimeUp();
    }, 20000);

    return () => {
      clearInterval(interval);
      clearTimeout(discussionTimeout);
    };
  }, [isDiscussing]);

  const handleTimeUp = async () => {
    if (!game) return;

    toast({
      title: "Time's up!",
      description: "Switching to the next team's turn",
      variant: "default",
    });

    await switchTurns();
    setTurnTimer(60); // Reset turn timer
  };

  const handleDiscussionTimeUp = async () => {
    if (!game) return;

    toast({
      title: "Discussion time's up!",
      description: "Time to make a decision",
      variant: "default",
    });

    setIsDiscussing(false);
    setDiscussionTimer(20); // Reset discussion timer
    await handleTeamDecision();
  };

  const handleTeamDecision = async () => {
    if (!game || !lastClue) return;

    const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";
    const teamDiscussion = game.teamDiscussion as TeamDiscussionEntry[];

    // Find the most confident suggestion
    const suggestions = teamDiscussion
      .filter(entry => entry.team === currentTeam && entry.suggestedWord)
      .sort((a, b) => b.confidence - a.confidence);

    if (suggestions.length > 0 && suggestions[0].confidence > 0.7) {
      await makeGuess.mutateAsync(suggestions[0].suggestedWord!);
    } else {
      await switchTurns();
    }
  };


  const switchTurns = async () => {
    try {
      setIsDiscussing(false);
      const nextTurn = game?.currentTurn === "red_turn" ? "blue_turn" : "red_turn";

      // Update the game state with the next turn
      await apiRequest("PATCH", `/api/games/${id}`, {
        currentTurn: nextTurn
      });

      // Reset all turn-related state
      setTurnTimer(60);
      setDiscussionTimer(20);
      setLastClue(null);
      aiTurnInProgress.current = false;

      // Refresh game data
      await queryClient.invalidateQueries({ queryKey: [`/api/games/${id}`] });
    } catch (error) {
      console.error("Error switching turns:", error);
      toast({
        title: "Error switching turns",
        description: "Please try again",
        variant: "destructive",
      });
    }
  };

  const renderTeamDiscussion = () => {
    if (!game) return null;

    const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";
    const teamColor = currentTeam === "red" ? "red" : "blue";
    const discussions = (game.teamDiscussion || []) as TeamDiscussionEntry[];

    // Sort discussions by timestamp in ascending order (oldest first)
    const sortedDiscussions = discussions
      .filter(entry => entry.team === currentTeam)
      .sort((a, b) => a.timestamp - b.timestamp);

    return (
      <Card className={`mt-4 border-${teamColor}-500 border-2`}>
        <CardContent className="p-4">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-bold text-lg">
              Team Discussion
            </h3>
            {isDiscussing && (
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4" />
                <span className={`text-sm font-medium ${
                  discussionTimer <= 10 ? 'text-red-500' : ''
                }`}>
                  {discussionTimer}s
                </span>
                {votingInProgress && (
                  <span className="text-sm text-green-500">
                    Voting in progress...
                  </span>
                )}
              </div>
            )}
          </div>

          <ScrollArea className="h-[300px]">
            <div className="space-y-3">
              {sortedDiscussions.map((entry, index) => {
                const modelInfo = AI_MODEL_INFO[entry.player as AIModel] || {
                  name: entry.player,
                  Icon: Bot
                };
                const { Icon } = modelInfo;
                const suggestedWord = entry.suggestedWord;

                return (
                  <div
                    key={index}
                    className={`p-4 rounded-lg ${
                      entry.team === "red"
                        ? "bg-red-50 text-red-900 border-red-200"
                        : "bg-blue-50 text-blue-900 border-blue-200"
                    } border`}
                  >
                    <div className="flex justify-between items-center mb-2">
                      <div className="flex items-center gap-2">
                        <Icon className="w-5 h-5" />
                        <span className="font-medium">{modelInfo.name}</span>
                      </div>
                      <span className="text-sm">
                        Confidence: {Math.round(entry.confidence * 100)}%
                      </span>
                    </div>
                    <p className="text-sm leading-relaxed">{entry.message}</p>
                    {suggestedWord && (
                      <p className="text-sm mt-2 font-medium">
                        Suggests: {suggestedWord}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    );
  };

  const getModelInfo = (model: AIModel) => {
    return AI_MODEL_INFO[model] || {
      name: model,
      Icon: AlertCircle
    };
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  const getAIGuess = useMutation({
    mutationFn: async (clue: { word: string; number: number }) => {
      const res = await apiRequest("POST", `/api/games/${id}/ai/guess`, { clue });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data;
    },
    onSuccess: async (data) => {
      if (data.guess) {
        await makeGuess.mutateAsync(data.guess);
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Error getting AI guess",
        description: error.message,
        variant: "destructive",
      });
      aiTurnInProgress.current = false;
    },
  });


  const [gameTimeLeft, setGameTimeLeft] = useState<number>(1800); // 30 minutes
  const gameTimerRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    if (!game) return;

    gameTimerRef.current = setInterval(() => {
      setGameTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(gameTimerRef.current);
          storage.updateGame(game.id, { gameState: "time_up" });
          return 0;
        }
        return prev - 1;
      });
    }, 1000);


    return () => {
      if (gameTimerRef.current) clearInterval(gameTimerRef.current);
    };
  }, [game?.id]);


  const formatTime = (seconds: number): string => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  if (isLoading || !game) {
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>;
  }

  const getCardColor = (word: string): string => {
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

  const currentTeam = game.currentTurn === "red_turn" ? "Red" : "Blue";
  const isSpymasterAI = game.currentTurn === "red_turn" ? game.redSpymaster : game.blueSpymaster;

  const getLogEmoji = (result: "correct" | "wrong" | "assassin" | "pending") => {
    switch (result) {
      case "correct": return <CheckCircle2 className="inline w-4 h-4 text-green-500" />;
      case "wrong": return <XCircle className="inline w-4 h-4 text-red-500" />;
      case "assassin": return "💀";
      case "pending": return <Clock className="inline w-4 h-4 text-gray-500" />;
      default: return "";
    }
  };

  // Update game log rendering to show proper model names and icons
  const renderGameLog = () => {
    return (
      <ScrollArea className="h-[200px]">
        <div className="space-y-2">
          {gameLog.map((log, index) => {
            const modelInfo = log.player ? AI_MODEL_INFO[log.player as AIModel] : null;
            const Icon = modelInfo?.Icon;
            const displayName = modelInfo?.name || log.team;

            return (
              <div
                key={index}
                className={`p-2 rounded text-sm ${
                  log.team === "red" ? "bg-red-50" : "bg-blue-50"
                }`}
              >
                <div className="flex items-center gap-2">
                  {Icon && <Icon className="w-4 h-4" />}
                  <span className="font-medium capitalize">
                    {displayName}
                  </span>
                  {log.action}
                  {getLogEmoji(log.result)}
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    );
  };

  return (
    <div className="min-h-screen bg-neutral-50 p-4">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold mb-4">Codenames AI</h1>

        <div className="flex justify-center items-center gap-6 mb-4">
          <div className="text-red-500 font-bold text-xl">Red: {game.redScore}</div>
          <div className={`px-6 py-2 rounded-full font-semibold ${
            game.currentTurn === "red_turn" ? "bg-red-100 text-red-700" : "bg-blue-100 text-blue-700"
          }`}>
            {currentTeam}'s Turn
          </div>
          <div className="text-blue-500 font-bold text-xl">Blue: {game.blueScore}</div>
        </div>

        <div className="flex items-center justify-center gap-4 mb-4">
          <div className="flex items-center gap-2">
            <Timer className="w-4 h-4" />
            <span className={`font-medium ${turnTimer <= 10 ? 'text-red-500' : ''}`}>
              Turn: {turnTimer}s
            </span>
          </div>
          {isDiscussing && (
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4" />
              <span className={`font-medium ${discussionTimer <= 10 ? 'text-red-500' : ''}`}>
                Discussion: {discussionTimer}s
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-center gap-2 mb-4">
          <Switch
            checked={isSpymasterView}
            onCheckedChange={setIsSpymasterView}
          />
          <span className="font-medium">Spymaster View</span>
        </div>
      </div>

      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 grid grid-cols-5 gap-3">
          {game.words.map((word) => (
            <Card
              key={word}
              className={`${getCardColor(word)} cursor-pointer transition-all hover:scale-105`}
              onClick={() => {
                if (!game.revealedCards.includes(word) && !game.gameState?.includes("win") && !aiTurnInProgress.current && !isDiscussing) {
                  makeGuess.mutate(word);
                }
              }}
            >
              <CardContent className="p-4 text-center">
                <span className={`font-medium ${getTextColor(word)}`}>
                  {word}
                </span>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="lg:col-span-4 space-y-4">
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