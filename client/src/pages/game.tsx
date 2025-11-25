import React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { type Game, type TeamDiscussionEntry, type ConsensusVote } from "@shared/schema";
import { useParams } from "wouter";
import { useEffect, useRef, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertCircle, CheckCircle2, XCircle, Clock, Timer, Bot, MessageSquare, Info } from "lucide-react";
import { SiOpenai, SiAnthropic, SiGooglegemini, SiX } from "react-icons/si";
import { storage } from "@/lib/storage";
import { motion, AnimatePresence } from "framer-motion";
import { MetaPoll } from "@/components/MetaPoll";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

// Update AI model display info with correct icon components
const AI_MODEL_INFO = {
  "gpt-4o": { name: "GPT-4", Icon: SiOpenai, color: "#74aa9c", logo: "/ai-logos/openai.svg" },
  "claude-sonnet-4-5-20250929": { name: "Claude", Icon: SiAnthropic, color: "#b980f0", logo: "/ai-logos/anthropic.svg" },
  "grok-4-fast-reasoning": { name: "Grok", Icon: SiX, color: "#333333", logo: "/ai-logos/x.svg" },
  "gemini-1.5-pro": { name: "Gemini", Icon: SiGooglegemini, color: "#4285f4", logo: "/ai-logos/gemini.svg" },
  "mistral": { name: "Mistral", Icon: Bot, color: "#7c3aed", logo: "/ai-logos/mistral.svg" },
  "deepseek": { name: "DeepSeek", Icon: Bot, color: "#5e81ac", logo: "/ai-logos/deepseek.svg" }
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

// Confidence Circle Component for displaying vote confidence percentage
function ConfidenceCircle({ confidence }: { confidence: number }) {
  const [progress, setProgress] = useState(0);
  const size = 48; // Increased from 32 (1.5x bigger)
  const strokeWidth = 5; // Slightly increased
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (progress / 100) * circumference;

  // Animate the circle filling
  useEffect(() => {
    const timer = setTimeout(() => {
      setProgress(confidence);
    }, 100);
    return () => clearTimeout(timer);
  }, [confidence]);

  // Determine color based on confidence
  const getColor = (value: number) => {
    if (value >= 70) return "rgb(34, 197, 94)"; // green-500
    if (value >= 50) return "rgb(245, 158, 11)"; // amber-500
    return "rgb(239, 68, 68)"; // red-500
  };

  return (
    <motion.div 
      className="relative flex items-center justify-center"
      initial={{ scale: 0.5, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      <svg width={size} height={size} className="transform -rotate-90">
        {/* Background circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          stroke="rgba(229, 231, 235, 0.5)" // gray-200 with opacity
          fill="white"
        />
        {/* Progress circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          stroke={getColor(confidence)}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          fill="transparent"
          className="transition-all duration-1000 ease-out"
        />
      </svg>
      {/* Percentage text */}
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-xs font-semibold">{confidence}%</span>
      </div>
    </motion.div>
  );
}

// Add this new component for the poll UI
const WordPoll = ({ 
  word, 
  votes, 
  teamColor = "red",
  onVote 
}: { 
  word: string; 
  votes: { yes: string[]; no: string[] }; 
  teamColor: "red" | "blue";
  onVote?: (word: string, vote: boolean) => void;
}) => {
  // Calculate percentages for the progress bars
  const totalVotes = votes.yes.length + votes.no.length;
  const yesPercentage = totalVotes === 0 ? 0 : Math.round((votes.yes.length / totalVotes) * 100);
  const noPercentage = totalVotes === 0 ? 0 : Math.round((votes.no.length / totalVotes) * 100);
  
  // Check if this word has already been revealed
  const isRevealed = game?.revealedCards?.includes(word);
  
  // If the word is already revealed, show a disabled/revealed state
  if (isRevealed) {
    return (
      <Card className={`w-full mb-4 shadow-md border border-gray-300 overflow-hidden opacity-60`}>
        <CardHeader className={`bg-gray-100 pb-2`}>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg font-medium text-gray-500">Already Revealed</CardTitle>
            <span className="text-sm text-muted-foreground">Card revealed</span>
          </div>
          <CardDescription>This word has already been guessed</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="text-xl font-bold text-center mb-5 py-2 px-4 bg-white rounded-md border inline-block mx-auto text-gray-400 line-through">
            {word}
          </div>
          
          <div className="flex items-center justify-center mt-2 text-gray-500 italic">
            <span>This card is already on the board</span>
          </div>
        </CardContent>
      </Card>
    );
  }
  
  // Normal display for unrevealed words
  return (
    <Card className={`w-full mb-4 shadow-md border border-${teamColor}-200 overflow-hidden`}>
      <CardHeader className={`bg-${teamColor}-50 pb-2`}>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-medium">Team Vote</CardTitle>
          <span className="text-sm text-muted-foreground">{totalVotes} votes</span>
        </div>
        <CardDescription>Should we guess this word?</CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        <div className="text-xl font-bold text-center mb-5 py-2 px-4 bg-white rounded-md border inline-block mx-auto">
          {word}
        </div>
        
        <div className="grid gap-3 mt-2">
          {/* Yes option */}
          <div className="relative">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${yesPercentage}%` }}
              transition={{ duration: 0.8, ease: "easeOut" }}
              className={`absolute top-0 left-0 h-full bg-green-500 opacity-20 rounded-md z-0`}
            />
            <div className="relative z-10 p-3 rounded-md border border-gray-200 flex justify-between items-center">
              <div className="flex items-center">
                <span className="font-medium text-green-700 mr-2">Yes</span>
                <div className="flex -space-x-2">
                  {votes.yes.map((modelId, i) => {
                    const ModelIcon = AI_MODEL_INFO[modelId as AIModel]?.Icon || Bot;
                    return (
                      <motion.div 
                        key={`yes-${modelId}-${i}`}
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ delay: i * 0.1, duration: 0.3 }}
                        className="w-7 h-7 rounded-full bg-green-100 flex items-center justify-center border-2 border-white"
                        title={getModelDisplayName(modelId as AIModel)}
                      >
                        {modelId === "human" ? (
                          <span className="text-xs">👤</span>
                        ) : (
                          <ModelIcon className="w-4 h-4" />
                        )}
                      </motion.div>
                    );
                  })}
                </div>
              </div>
              <span className="font-semibold">{yesPercentage}%</span>
            </div>
          </div>
          
          {/* No option */}
          <div className="relative">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${noPercentage}%` }}
              transition={{ duration: 0.8, ease: "easeOut" }}
              className={`absolute top-0 left-0 h-full bg-red-500 opacity-20 rounded-md z-0`}
            />
            <div className="relative z-10 p-3 rounded-md border border-gray-200 flex justify-between items-center">
              <div className="flex items-center">
                <span className="font-medium text-red-700 mr-2">No</span>
                <div className="flex -space-x-2">
                  {votes.no.map((modelId, i) => {
                    const ModelIcon = AI_MODEL_INFO[modelId as AIModel]?.Icon || Bot;
                    return (
                      <motion.div 
                        key={`no-${modelId}-${i}`}
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ delay: i * 0.1, duration: 0.3 }}
                        className="w-7 h-7 rounded-full bg-red-100 flex items-center justify-center border-2 border-white"
                        title={getModelDisplayName(modelId as AIModel)}
                      >
                        {modelId === "human" ? (
                          <span className="text-xs">👤</span>
                        ) : (
                          <ModelIcon className="w-4 h-4" />
                        )}
                      </motion.div>
                    );
                  })}
                </div>
              </div>
              <span className="font-semibold">{noPercentage}%</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

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
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  
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
  const [isVotingActive, setIsVotingActive] = useState(false);
  const [localDiscussion, setLocalDiscussion] = useState<TeamDiscussionEntry[]>([]);
  const [displayedPolls, setDisplayedPolls] = useState(new Set<string>());
  
  // Track models that have voted on words and meta actions to prevent duplicates
  const [votedOnWords, setVotedOnWords] = useState<Record<string, Set<string>>>({});
  const [votedOnMeta, setVotedOnMeta] = useState<Record<string, Set<string>>>({});
  
  // Current state of votes for decision making
  const [wordVoteCounts, setWordVoteCounts] = useState<Record<string, { 
    count: number, 
    threshold: number,
    voters: string[] 
  }>>({});

  // Add this state variable near the other state hooks
  const [highlightGameWords, setHighlightGameWords] = useState(false);

  // Add this state near your other state hooks
  const [expandedReasonings, setExpandedReasonings] = useState<Record<string, boolean>>({});

  // Query hook
  const { data: game, isLoading, isError } = useQuery<Game>({
    queryKey: [`/api/games/${id}`],
    refetchInterval: 1000,
    refetchIntervalInBackground: true
  });

  // Define formatMessage at component level, before it's used
  const formatMessage = (message: string, forceHighlight: boolean = false) => {
    if (!message) return "";
    
    // First handle line breaks and spaces
    let formatted = message;
    
    // Handle different types of line break notations
    formatted = formatted.replace(/\/n/g, '<br/>');
    formatted = formatted.replace(/\\n/g, '<br/>');
    formatted = formatted.replace(/\n/g, '<br/>');
    
    // Replace multiple spaces with &nbsp;
    formatted = formatted.replace(/ {2,}/g, (match) => {
      return '&nbsp;'.repeat(match.length);
    });
    
    // If word highlighting is enabled OR forceHighlight is true, highlight game words
    if ((highlightGameWords || forceHighlight) && game) {
      // Process all game words
      game.words.forEach(gameWord => {
        // Determine highlight color based on word type
        let highlightClass = '';
        
        if (game.redTeam.includes(gameWord)) {
          highlightClass = 'background-color:#ffcccc;';
        } else if (game.blueTeam.includes(gameWord)) {
          highlightClass = 'background-color:#cce5ff;';
        } else if (game.assassin === gameWord) {
          highlightClass = 'background-color:#333;color:white;';
        } else {
          // Neutral word
          highlightClass = 'background-color:#f5f5dc;';
        }
        
        // Always keep text bold but maintain its natural color (except for assassin)
        const style = `${highlightClass}font-weight:bold;padding:0 3px;border-radius:3px;`;
        
        // Create patterns that explicitly match the word in various formats
        // This will allow us to properly handle formatting characters
        
        // 1. Match **WORD** pattern (markdown bold)
        const boldPattern = new RegExp(`\\*\\*(${gameWord})\\*\\*`, 'gi');
        formatted = formatted.replace(boldPattern, `<span style="${style}">${gameWord}</span>`);
        
        // 2. Match 'WORD' pattern (single quotes)
        const singleQuotePattern = new RegExp(`'(${gameWord})'`, 'gi');
        formatted = formatted.replace(singleQuotePattern, `<span style="${style}">${gameWord}</span>`);
        
        // 3. Match "WORD" pattern (double quotes)
        const doubleQuotePattern = new RegExp(`"(${gameWord})"`, 'gi');
        formatted = formatted.replace(doubleQuotePattern, `<span style="${style}">${gameWord}</span>`);
        
        // 4. Finally, match standalone word with word boundaries
        // But be careful not to match parts of already highlighted spans
        const plainWordPattern = new RegExp(`(?<!<[^>]*)\\b(${gameWord})\\b(?![^<]*>)`, 'gi');
        formatted = formatted.replace(plainWordPattern, `<span style="${style}">${gameWord}</span>`);
      });
    }
    
    // AFTER word highlighting, handle other formatting like bold text
    // Replace double asterisks with bold tags (if not already highlighted)
    formatted = formatted.replace(/\*\*([^<>]*?)\*\*/g, '<strong>$1</strong>');
    
    return formatted;
  };
  
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
          
          // CRITICAL FIX: Handle meta_vote messages for game log
          if (data.type === 'meta_vote') {
            console.log('Received meta vote message:', data);
            
            // CRITICAL: Validate and ensure team is correctly set
            // Use the team explicitly from the data, with fallback to current game team
            const metaVoteTeam = data.team || (game?.currentTurn === "red_turn" ? "red" : "blue");
            console.log(`📊 Adding meta vote for team: ${metaVoteTeam}, action: ${data.action}`);
            
            // Add meta vote to game log with explicit team attribution
            setGameLog(prev => [...prev, {
              team: metaVoteTeam, // Use validated team
              action: `${data.player} voted to ${data.action === 'continue' ? 'continue guessing' : 'end turn'}`,
              type: "meta_vote",
              player: data.player,
              reasoning: data.reasoning,
              timestamp: data.timestamp || Date.now(), // Ensure timestamp exists
              voteAction: data.action // Add explicit vote action for UI display
            }]);
          }

          if (data.type === 'discussion') {
            // Create the new discussion entry with all required fields
            const newEntry = {
              team: data.team,
              player: data.player,
              message: data.content || data.message || '',
              timestamp: data.timestamp || Date.now(),
              // Add required fields with default values
              confidences: data.confidences || [data.confidence || 0.5],
              suggestedWords: data.suggestedWords || [],
              isVoting: !!data.isVoting,
              voteType: data.voteType
            };
            
            // Update local state immediately for instant UI update
            setLocalDiscussion(prev => [...prev, {
              ...newEntry,
              confidences: newEntry.confidences || [],
              suggestedWords: newEntry.suggestedWords || []
            }]);
            
            // Also update React Query cache
            queryClient.setQueryData([`/api/games/${id}`], (oldData: Game | undefined) => {
              if (!oldData) return oldData;
              
              // Add the revealed card
              const updatedRevealedCards = [...(oldData.revealedCards || [])];
              if (!updatedRevealedCards.includes(data.word)) {
                updatedRevealedCards.push(data.word);
              }
              
              return {
                ...oldData,
                teamDiscussion: [...(oldData.teamDiscussion || []), newEntry]
              };
            });

            // Force immediate game data refresh
            queryClient.invalidateQueries({ 
              queryKey: [`/api/games/${id}`],
              refetchType: 'active',
              exact: true
            });

            // If the message has suggested words with high confidence, track them for potential voting
            if (newEntry.suggestedWords?.length > 0 && newEntry.confidences?.[0] >= 0.6) {
              newEntry.suggestedWords.forEach((word: string, index: number) => {
                // Get the confidence for this word
                const confidence = newEntry.confidences && index < newEntry.confidences.length 
                  ? newEntry.confidences[index] 
                  : 0.5;
                
                // Only track high confidence suggestions
                if (confidence >= 0.6) {
                  setWordVoteCounts(prev => {
                    // Initialize if this word isn't already tracked
                    if (!prev[word]) {
                      return {
                        ...prev,
                        [word]: { 
                          count: 1, 
                          threshold: 2, // Need at least 2 votes to guess
                          voters: [newEntry.player] 
                        }
                      };
                    }
                    
                    // If this player hasn't already voted for this word, count their vote
                    if (!prev[word].voters.includes(newEntry.player)) {
                      return {
                        ...prev,
                        [word]: {
                          count: prev[word].count + 1,
                          threshold: prev[word].threshold,
                          voters: [...prev[word].voters, newEntry.player]
                        }
                      };
                    }
                    
                    return prev;
                  });
                }
              });
            }
          }

          if (data.type === 'guess') {
            const audio = new Audio("notification.mp3");
            audio.play();
            console.log(`🎲 Received guess event: ${data.word} - ${data.result}`);
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
            
            // Add a discussion message about the guess
            const newDiscussionEntry = {
              team: data.team,
              player: 'Game',
              message: `${data.player || 'Someone'} guessed: ${data.word} (${guessResult})`,
              confidences: [1],
              suggestedWords: [],
              timestamp: data.timestamp || Date.now()
            };
            
            // Update local discussion
            setLocalDiscussion(prev => [...prev, {
              ...newDiscussionEntry,
              confidences: newDiscussionEntry.confidences || [],
              suggestedWords: newDiscussionEntry.suggestedWords || []
            }]);
            
            // Update React Query cache with revealed card and discussion entry
            queryClient.setQueryData([`/api/games/${id}`], (oldData: Game | undefined) => {
              if (!oldData) return oldData;
              
              // Add the revealed card
              const updatedRevealedCards = [...(oldData.revealedCards || [])];
              if (!updatedRevealedCards.includes(data.word)) {
                updatedRevealedCards.push(data.word);
              }
              
              return {
                ...oldData,
                revealedCards: updatedRevealedCards,
                teamDiscussion: [...(oldData.teamDiscussion || []), newDiscussionEntry]
              };
            });

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
              
              // Add turn change notification
              const nextTeam = data.team === 'red' ? 'blue' : 'red';
              const turnChangeEntry = {
                team: data.team,
                player: 'Game',
                message: `Turn ended. ${nextTeam.toUpperCase()} team's turn now.`,
                confidences: [1],
                suggestedWords: [],
                timestamp: (data.timestamp || Date.now()) + 1
              };
              
              setLocalDiscussion(prev => [...prev, turnChangeEntry]);
            }
          }

          if (data.type === 'clue') {
            queryClient.invalidateQueries({ 
              queryKey: [`/api/games/${id}`],
              refetchType: 'active',
              exact: true
            });
          }
          
          if (data.type === 'turn_change') {
            console.log(`🔄 Turn change event: ${data.from} → ${data.to}, reason: ${data.reason || 'manual'}`);
            
            // Create a message for the turn change
            const message = `Turn ended${data.reason ? ` (${data.reason})` : ''}. ${data.to.toUpperCase()} team's turn now.`;
            
            // Add to local discussion state for immediate display
            const turnChangeEntry = {
              team: data.from,
              player: 'Game',
              message: message,
              confidences: [1],
              suggestedWords: [],
              timestamp: data.timestamp || Date.now()
            };
            
            // Update local state
            setLocalDiscussion(prev => [...prev, turnChangeEntry]);
            
            // Also update game state in UI cache
            queryClient.setQueryData([`/api/games/${id}`], (oldData: Game | undefined) => {
              if (!oldData) return oldData;
              return {
                ...oldData,
                currentTurn: data.to === 'red' ? 'red_turn' : 'blue_turn',
                teamDiscussion: [...(oldData.teamDiscussion || []), turnChangeEntry]
              };
            });
            
            // Force refresh game data
            queryClient.invalidateQueries({ 
              queryKey: [`/api/games/${id}`],
              refetchType: 'active'
            });
            
            // Reset state for new turn
            setLastClue(null);
            setIsDiscussing(false);
            aiTurnInProgress.current = false;
            processedGameState.current = false;
            
            // Clear all voting state for the new turn
            setVotedOnWords({});
            setVotedOnMeta({});
            setWordVoteCounts({});
            console.log("Cleared voting state for new turn");
          }
        } catch (error) {
          console.error('WebSocket message error:', error);
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
  }, [id, game]);

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
  
  // Clear team discussion when turn changes - FIX: More robust implementation
  const prevTurnRef = useRef(game?.currentTurn);
  
  useEffect(() => {
    if (!game) return;
    
    // Only clear and reset discussion if the turn has actually changed
    if (prevTurnRef.current !== game.currentTurn) {
      console.log(`🔄 Turn changed from ${prevTurnRef.current} to ${game.currentTurn} - Clearing team discussion`);
      
      // Update the ref to current turn
      prevTurnRef.current = game.currentTurn;
      
      // When turn changes, clear local discussion state
      setLocalDiscussion([]);
      
      // Add a fresh discussion start message with a clear separator
      const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";
      const newTurnMessage: TeamDiscussionEntry = {
        team: currentTeam as "red" | "blue",
        player: 'Game',
        message: `=== ${currentTeam.toUpperCase()} TEAM'S TURN - New Discussion Begins ===`,
        timestamp: Date.now(),
        confidences: [1],
        suggestedWords: []
      };
      
      setLocalDiscussion([newTurnMessage]);
      
      // Reset all voting state for the new turn
      setVotedOnWords({});
      setVotedOnMeta({});
      setWordVoteCounts({});
      setDisplayedPolls(new Set<string>());
      
      // Also broadcast this as a major state change via WebSocket
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({
          type: 'discussion',
          team: currentTeam,
          player: 'Game',
          content: `=== ${currentTeam.toUpperCase()} TEAM'S TURN - New Discussion Begins ===`,
          message: `=== ${currentTeam.toUpperCase()} TEAM'S TURN - New Discussion Begins ===`,
          timestamp: Date.now(),
          isTurnChange: true
        }));
      }
      
      // Clear server-side discussion for the previous team
      const previousTeam = prevTurnRef.current === "red_turn" ? "red" : "blue";
      if (previousTeam && socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({
          type: 'clear_discussion',
          team: previousTeam,
          gameId: Number(id),
          timestamp: Date.now()
        }));
      }
    }
  }, [game?.currentTurn, id]);

  // All mutation hooks - define all of them before conditional returns
  const switchTurns = useMutation({
    mutationFn: async () => {
      if (!game) return null;
      
      // Instead of direct API call, use our consistent shared handler
      handleTurnChange('manual');
      return { success: true };
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

      const audio = new Audio("/notification.mp3");
      audio.play().catch((e) => console.error("Playback failed:", e));
      
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

  // CRITICAL FIX: Double-reinforced timer expiration handler for mandatory turn changes
  // This will change turns when time expires regardless of whether the team guessed correctly or not
  useEffect(() => {
    // Only execute when the timer reaches zero and there's an active game
    if (!game || turnTimer !== 0 || game.gameState?.includes("win")) return;
    
    console.log("⏰⏰ TIMER REACHED ZERO - FORCEFULLY changing turn ⏰⏰");
    
    // Determine current and next team information
    const isRedTurn = game.currentTurn === "red_turn";
    const nextTurn = isRedTurn ? "blue_turn" : "red_turn";
    const currentTeam = isRedTurn ? "red" : "blue";
    const nextTeam = isRedTurn ? "blue" : "red";
    
    // MAKE THIS CRITICAL - Log multiple obvious console messages to track execution
    console.log(`🚨 TIMER EXPIRED - ${currentTeam.toUpperCase()} → ${nextTeam.toUpperCase()}`);
    console.log(`🚨 SENDING MULTIPLE REDUNDANT TURN CHANGE REQUESTS FOR RELIABILITY`);
    
    // 1. Send meta vote with timer expiration flag FIRST - most reliable way
    // This will override any "continue guessing" decision since time has run out
    const metaVotePromise = fetch(`/api/games/${id}/meta/vote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'Game',
        team: currentTeam,
        action: 'end_turn',
        timerExpired: true, // CRITICAL - explicitly mark as timer expiration
        highPriority: true
      })
    })
    .then(res => res.json())
    .catch(err => console.error("Error sending timer-based meta vote:", err));
    
    // 2. ALSO make a parallel direct PATCH request to ensure the turn absolutely changes
    // This is redundant but ensures turn switching even if one method fails
    const directPatchPromise = apiRequest("PATCH", `/api/games/${id}`, {
      currentTurn: nextTurn,
      currentTurnStartTime: new Date(), // CRITICAL: Reset timer
      _forceTimerSwitch: true, // Signal this is from timer expiration
      _timestamp: Date.now(),
      forceTimerExpiration: true // Additional signal
    })
    .then(res => res.json())
    .catch(err => console.error("Error in direct PATCH for timer expiration:", err));
    
    // 3. ALSO send a WebSocket message to everyone about the turn change
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: 'turn_change',
        from: currentTeam,
        to: nextTeam,
        reason: 'time_expired',
        gameId: Number(id),
        timestamp: Date.now(),
        forced: true,
        highPriority: true
      }));
      
      // Send a discussion message as well
      socketRef.current.send(JSON.stringify({
        type: 'discussion',
        gameId: Number(id),
        team: currentTeam,
        player: 'Game',
        content: `⏰ TIME EXPIRED! Turn forcibly switched to ${nextTeam.toUpperCase()} team.`,
        timestamp: Date.now(),
        highPriority: true
      }));
    }
    
    // 4. After all promises complete, ensure client state is updated correctly
    Promise.all([metaVotePromise, directPatchPromise])
      .then(() => {
        console.log("✅ Multiple turn change mechanisms executed - verifying state");
        
        // Reset all local state for clean turn transition
        setLastClue(null);
        setIsDiscussing(false);
        
        // Only reset timer if it's not a spymaster giving a clue
        // In this timer expiration context, we're always resetting the timer
        // but we'll maintain the pattern for consistency
        const isSpymasterGivingClue = localStorage.getItem(`game-${id}-next-action`) === 'request_clue';
        
        if (!isSpymasterGivingClue) {
            setTurnTimer(60); // Reset timer only when not giving clue
        }
        
        // Clear displayedPolls on turn change so that new polls can be created in the next turn
        setDisplayedPolls(new Set());
        
        aiTurnInProgress.current = false;
        processedGameState.current = false;
        setVotedOnWords({});
        setVotedOnMeta({});
        setWordVoteCounts({});
        
        // CRITICAL: Force React Query to refetch and update UI state
        queryClient.invalidateQueries({ 
          queryKey: [`/api/games/${id}`],
          refetchType: 'active'
        });
      })
      .catch(err => console.error("Error in timer-based turn change processing:", err));
    
    // 5. Set a fallback timeout to check if turn actually changed
    setTimeout(() => {
      // Re-fetch game data to check if turn was actually changed
      fetch(`/api/games/${id}`)
        .then(res => res.json())
        .then(currentGame => {
          if (currentGame.currentTurn === game.currentTurn) {
            // If turn hasn't changed, try ONE MORE absolute last-resort method
            console.error("🚨 EMERGENCY: Turn did not change after timer expiration, trying final method");
            
            // LAST RESORT: Direct database update with PATCH
            apiRequest("PATCH", `/api/games/${id}`, {
              currentTurn: nextTurn,
              currentTurnStartTime: new Date(),
              _EMERGENCY_TURN_CHANGE: true
            }).then(() => {
              // Hard reset of all local state to ensure clean UI
              setLocalDiscussion([]);
              setVotedOnWords({});
              setVotedOnMeta({});
              setWordVoteCounts({});
              setDisplayedPolls(new Set<string>());
              
              // Force refetch after this emergency action
              queryClient.invalidateQueries({ 
                queryKey: [`/api/games/${id}`],
                refetchType: 'active'
              });
            });
          }
        })
        .catch(err => console.error("Error in fallback turn verification:", err));
    }, 2000); // Check after 2 seconds
    
  }, [turnTimer, game?.id, game?.currentTurn, game?.gameState]);

  // Shared function to handle turn changes consistently
  const handleTurnChange = (reason: string) => {
    if (!game) return;
    
    // Use the centralized forceTurnChange function to handle all turn switching
    // This will be passed down from the timer useEffect
    console.log(`🔄 Triggering turn change: ${reason}`);
    
    // Get the current turn information
    const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";
    const nextTeam = game.currentTurn === "red_turn" ? "blue" : "red";
    const nextTurnState = game.currentTurn === "red_turn" ? "blue_turn" : "red_turn";
    
    // THREE PARALLEL METHODS to ensure the turn absolutely changes:
    
    // METHOD 1: Meta vote with high priority flag (most reliable way)
    const metaVotePromise = fetch(`/api/games/${game.id}/meta/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'Game',
        team: currentTeam,
        action: 'end_turn',
        highPriority: true,
        timestamp: Date.now()
      })
    })
    .then(res => res.json())
    .catch(err => {
      console.error('Meta vote method failed, trying backup methods:', err);
      return { error: true };
    });
    
    // METHOD 2: Direct PATCH to game state (backup method)
    const directPatchPromise = fetch(`/api/games/${game.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        currentTurn: nextTurnState,
        currentTurnStartTime: new Date(),
        _timestamp: Date.now()
      })
    })
    .then(res => res.json())
    .catch(err => {
      console.error('Direct PATCH method failed:', err);
      return { error: true };
    });
    
    // METHOD 3: WebSocket broadcast (notification method)
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: 'turn_change',
        from: currentTeam,
        to: nextTeam,
        reason: reason,
        gameId: Number(game.id),
        timestamp: Date.now(),
        forced: true,
        highPriority: true
      }));
    }
    
    // Process all turn change attempts and reset client state
    Promise.all([metaVotePromise, directPatchPromise])
      .then(() => {
        console.log('✅ All turn change mechanisms executed for: ' + reason);
        
        // RESET ALL CLIENT STATE for a clean transition
        setLastClue(null);
        setIsDiscussing(false);
        setTurnTimer(60); // Reset timer explicitly for the next turn
        aiTurnInProgress.current = false;
        processedGameState.current = false;
        aiDiscussionTriggered.current = false;
        setVotedOnWords({});
        setVotedOnMeta({});
        setWordVoteCounts({});
        
        // Force refresh all game data
        queryClient.invalidateQueries({ 
          queryKey: [`/api/games/${game.id}`],
          refetchType: 'active'
        });
      });
  };

  // Enhanced makeGuess function with immediate turn changes and automatic guessing
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

      console.log(`🎯 Making guess for word: ${word}`);
      
      // First, reveal the card
      const res = await apiRequest("PATCH", `/api/games/${id}`, {
        revealedCards: [...(game?.revealedCards || []), word],
        guessingTeam: game.currentTurn === "red_turn" ? "red" : "blue"
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);
      
      // Determine the type of word guessed
      const isRedTurn = game.currentTurn === "red_turn";
      const currentTeam = isRedTurn ? "red" : "blue"; 
      const isAssassin = word === game.assassin;
      const isRedTeamWord = game.redTeam.includes(word);
      const isBlueTeamWord = game.blueTeam.includes(word);
      const isCorrectTeamWord = isRedTurn ? isRedTeamWord : isBlueTeamWord;
      const isOpponentTeamWord = isRedTurn ? isBlueTeamWord : isRedTeamWord;
      const isNeutralWord = !isRedTeamWord && !isBlueTeamWord && !isAssassin;
      
      // Result to send to the server and display
      const result = isCorrectTeamWord ? "correct" : 
                    isAssassin ? "assassin" : 
                    "wrong"; // Both neutral and opponent words count as "wrong"
      
      // Log the guess for UI feedback
      console.log(`🎲 GUESS: ${word} | Team: ${currentTeam} | Result: ${result}`);
      
      // Create a discussion message about the guess to ensure it appears in chat
      const guessMessage = {
        team: currentTeam,
        player: 'Game',
        message: `Guessed: ${word} (${result})`,
        timestamp: Date.now()
      };
      
      // Send the discussion message via WebSocket
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({
          ...guessMessage,
          type: 'discussion',
          gameId: Number(id)
        }));
      }
      
      // Also add to game log for the UI sidebar
      setGameLog(prev => [...prev, {
        team: currentTeam,
        action: `Guessed: ${word}`,
        result,
        word,
        player: "human",
        timestamp: Date.now()
      }]);
      
      // Use manual WebSocket for broadcasting since we don't have a broadcast endpoint
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({
          type: 'guess',
          gameId: Number(id),
          team: currentTeam,
          word,
          result,
          timestamp: Date.now()
        }));
      }
      
      // ALWAYS create a meta-vote decision after EVERY correct guess
       if (result === "correct") {
        console.log("✅ CORRECT GUESS - INITIATING META DECISION FLOW");
        
        // Force refresh game data to ensure score UI updates immediately
        await queryClient.invalidateQueries({ 
          queryKey: [`/api/games/${id}`],
          refetchType: 'all'
        });
        
        // CRITICAL: Reset all voting state to ensure a fresh poll after every correct guess
        setVotingInProgress(true); // Immediately block further guessing
        setDisplayedPolls(new Set()); // Clear any displayed polls
        
        // Clear any previous poll data from localStorage to ensure completely fresh polls
        Object.keys(localStorage)
          .filter(key => 
            key.startsWith('poll_votes_') || 
            key.startsWith('voted-meta-') || 
            key.startsWith(`voted-${currentTeam}-`) ||
            key === 'votingInProgress' ||
            key.startsWith('active-metapoll-')
          )
          .forEach(key => localStorage.removeItem(key));
        
        // Always force a new meta poll after every correct guess
        const now = Date.now();
        let metaPollId = `meta-${currentTeam}-${now}-decision`;
        
        // Set this as the active metapoll for this team
        const existingMetaPollKey = `active-metapoll-${currentTeam}`;
        localStorage.setItem(existingMetaPollKey, `${metaPollId}|${now}`);
        console.log(`🆕 Created new metapoll after correct guess: ${metaPollId}`);
        
        // Add a meta decision entry with explicit voting flags
        const metaDecisionMsg = {
          team: currentTeam,
          player: 'Game',
          message: "Team must decide: continue guessing or end turn?",
          timestamp: now,
          isVoting: true, // CRITICAL: Mark as voting message
          voteType: 'meta_decision',
          metaOptions: ['continue', 'end_turn'],
          pollId: metaPollId, // CRITICAL: Add explicit poll ID for easy matching with votes 
          messageId: metaPollId // Also use same ID as messageId for redundancy
        };
        
        setLocalDiscussion(prev => [...prev, metaDecisionMsg]);
        
        // Send via WebSocket for real-time updates
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(JSON.stringify({
            ...metaDecisionMsg,
            type: 'discussion',
            gameId: Number(id),
            pollId: metaPollId,
            messageId: metaPollId
          }));
        }
        
        // Request AI models to vote on continue/end turn
        fetch(`/api/games/${id}/meta/discuss`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: "Should we continue guessing or end turn?",
            team: currentTeam,
            triggerVoting: true,
            pollId: metaPollId,
            messageId: metaPollId,
            isVoting: true,
            voteType: 'meta_decision'
          })
        }).catch(err => console.error("Error triggering AI meta vote:", err));
        
        // Always create a meta vote display in the UI for humans to vote
        setIsVotingActive(true);
      }
      
      // CRITICAL FIX: Turn only changes when guessing wrong words (neutral/opponent/assassin)
      // For correct guesses, we show meta-voting to let team decide to continue or end turn
      if (!isCorrectTeamWord || isNeutralWord || isOpponentTeamWord || isAssassin) {
        console.log(`🔄 IMMEDIATE turn switch after ${result} guess (wrong/opponent/neutral/assassin)`);
        
        // Special handling for assassin (set game state)
        if (isAssassin) {
          // Make special API call just for setting the win state
          apiRequest("PATCH", `/api/games/${id}`, {
            gameState: isRedTurn ? "blue_win" : "red_win"
          });
        }
        
        // CRITICAL FIX: If it's an opponent's word, ensure the opponent gets a point
        if (isOpponentTeamWord) {
          console.log(`📈 Opponent team (${isRedTurn ? 'blue' : 'red'}) gets a point for revealing their word`);
          
          // The score update for opponent's word is now handled consistently in handleGuess on the server side
          // This ensures the opponent always gets points regardless of who made the guess and how
          // We just need to ensure we refresh the UI to show the updated score
          
          // Force refresh game data to ensure score UI updates immediately
          queryClient.invalidateQueries({ 
            queryKey: [`/api/games/${id}`],
            refetchType: 'all'
          });
        }
        
        // Get the specific reason for turn change
        let turnChangeReason = 'wrong_guess';
        if (isAssassin) {
          turnChangeReason = 'assassin';
        } else if (isOpponentTeamWord) {
          turnChangeReason = 'opponent_word';
        } else if (isNeutralWord) {
          turnChangeReason = 'neutral_word';
        }
        
        // Use shared turn change handler for incorrect guesses only
        handleTurnChange(turnChangeReason);
      } else {
        // CRITICAL FIX: For correct guesses, team continues their turn 
        // BUT we show meta-voting to let them choose to end their turn or continue
        console.log("✅ Correct guess! Team continues their turn with meta decision option");
        
        // Create an enhanced informational message about the correct guess with animations
        const successMsg = {
          team: currentTeam,
          player: 'Game',
          message: `✅ CORRECT GUESS! "${word}" was a ${currentTeam.toUpperCase()} team card. Your team gets a point.`,
          timestamp: Date.now(),
          animate: true, // Add animation flag for special styling
          cardType: currentTeam // To show the color of the card
        };
        
        // Send via WebSocket and update local state
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(JSON.stringify({
            ...successMsg,
            type: 'discussion',
            gameId: Number(id)
          }));
        }
        
        setLocalDiscussion(prev => [...prev, successMsg]);
        
        // Add a small delay before showing the meta decision to ensure users see the correct guess confirmation
        setTimeout(() => {
          // Additional clarification that team must now decide what to do
          const decisionPromptMsg = {
            team: currentTeam,
            player: 'Game',
            message: `Team must now decide whether to continue guessing or end the turn.`,
            timestamp: Date.now() + 100,
            isVoting: true,
            leadToMetaVote: true // Flag to indicate this will lead to a meta vote
          };
          
          // Send via WebSocket and update local state
          if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({
              ...decisionPromptMsg,
              type: 'discussion',
              gameId: Number(id)
            }));
          }
          
          setLocalDiscussion(prev => [...prev, decisionPromptMsg]);
        }, 1000);
        
        // Reset word votes
        setVotedOnWords({});
        setWordVoteCounts({});
        
        // IMMEDIATELY check for high-confidence words to guess next
        // Run directly in aggressive auto-guesser mode to find candidate words
        const teamDiscussion = game.teamDiscussion?.filter(msg => msg.team === currentTeam) || [];
        
        // Build word suggestion map
        const wordSuggestions = new Map();
        
        teamDiscussion.forEach(msg => {
          if (!msg.suggestedWords || msg.suggestedWords.length === 0) return;
          
          msg.suggestedWords.forEach((word: string, index: number) => {
            // Skip meta options and revealed cards
            if (word === "CONTINUE" || word === "END TURN" || game.revealedCards.includes(word)) {
              // If it's a revealed card being suggested, tell the AI it was already guessed
              if (game.revealedCards.includes(word)) {
                // Add message only if this is a recent suggestion (within last few messages)
                const isRecentSuggestion = teamDiscussion.indexOf(msg) >= teamDiscussion.length - 3;
                if (isRecentSuggestion) {
                  const alreadyGuessedMsg: TeamDiscussionEntry = {
                    team: currentTeam as "red" | "blue",
                    player: 'Game',
                    message: `"${word}" was already correctly guessed. Try a different word.`,
                    timestamp: Date.now(),
                    suggestedWords: [],
                    confidences: []
                  };
                  
                  // Add to discussion for immediate feedback
                  setLocalDiscussion(prev => [...prev, alreadyGuessedMsg]);
                  
                  // Broadcast to all clients
                  if (socketRef.current?.readyState === WebSocket.OPEN) {
                    socketRef.current.send(JSON.stringify({
                      ...alreadyGuessedMsg,
                      type: 'discussion',
                      gameId: Number(id)
                    }));
                  }
                }
              }
              return;
            }
            
            // Get confidence for this word
            const confidence = msg.confidences && index < msg.confidences.length 
              ? msg.confidences[index] 
              : 0.5;
            
            // Initialize if needed
            if (!wordSuggestions.has(word)) {
              wordSuggestions.set(word, {
                count: 0,
                totalConfidence: 0,
                sources: new Set(),
                maxConfidence: 0
              });
            }
            
            // Update stats
            const stats = wordSuggestions.get(word);
            stats.count++;
            stats.totalConfidence += confidence;
            stats.sources.add(msg.player);
            
            // Track highest confidence
            if (confidence > stats.maxConfidence) {
              stats.maxConfidence = confidence;
            }
          });
        });
        
        // Find the best candidate word
        const bestCandidates = Array.from(wordSuggestions.entries())
          .map(([word, stats]) => ({
            word,
            count: stats.count,
            sources: stats.sources.size,
            avgConfidence: stats.totalConfidence / stats.count,
            maxConfidence: stats.maxConfidence
          }))
          .filter(c => c.avgConfidence > 0.6) // Only high confidence
          .sort((a, b) => {
            if (a.sources !== b.sources) return b.sources - a.sources;
            if (a.count !== b.count) return b.count - a.count;
            return b.avgConfidence - a.avgConfidence;
          });
        
        // If we have a high confidence candidate, display it
        if (bestCandidates.length > 0) {
          const bestWord = bestCandidates[0];
          console.log(`🎮 Found high confidence next guess: ${bestWord.word}`);
          
          // Add this to the meta decision message
          const nextGuessMsg: TeamDiscussionEntry = {
            team: currentTeam as "red" | "blue",
            player: 'Game',
            message: `Team can continue and guess "${bestWord.word}" (${Math.round(bestWord.avgConfidence * 100)}% confidence) or end turn.`,
            timestamp: Date.now() + 1,
            isVoting: true,
            voteType: 'continue',
            suggestedWords: [bestWord.word],
            confidences: [bestWord.avgConfidence]
          };
          
          setLocalDiscussion(prev => [...prev, nextGuessMsg]);
          
          // Broadcast
          if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({
              ...nextGuessMsg,
              type: 'discussion',
              gameId: Number(id)
            }));
          }
          
          // Also add a vote for this word to encourage guessing
          fetch(`/api/games/${id}/ai/vote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'Game',
              team: currentTeam,
              word: bestWord.word
            })
          }).catch(err => console.error("Error submitting next word vote:", err));
        } else {
          // No good candidates, recommend ending turn
          const endTurnRecommendationMsg = {
            team: currentTeam,
            player: 'Game',
            message: "No high confidence words found. Team should consider ending turn.",
            timestamp: Date.now() + 1,
            isVoting: true,
            voteType: 'end_turn'
          };
          
          setLocalDiscussion(prev => [...prev, endTurnRecommendationMsg]);
          
          // Broadcast
          if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({
              ...endTurnRecommendationMsg,
              type: 'discussion',
              gameId: Number(id)
            }));
          }
          
          // Submit a meta vote for ending turn
          fetch(`/api/games/${id}/meta/vote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'Game',
              team: currentTeam,
              action: 'end_turn'
            })
          }).catch(err => console.error("Error submitting end turn recommendation:", err));
        }
        
        // Check if there's already an active metapoll for this team
        const existingMetaPollKey = `active-metapoll-${currentTeam}`;
        const existingMetaPoll = localStorage.getItem(existingMetaPollKey);
        const now = Date.now();
        
        // Only create a new metapoll if there isn't an active one or if the previous one is older than 30 seconds
        let shouldCreateNewMetaPoll = true;
        let metaPollId;
        
        if (existingMetaPoll) {
          const [savedPollId, savedTimestamp] = existingMetaPoll.split('|');
          const pollAge = now - parseInt(savedTimestamp);
          
          // If we have a recent poll (less than 30 seconds old), use it instead of creating a new one
          if (pollAge < 30000) {
            console.log(`⚠️ Using existing metapoll: ${savedPollId} (${pollAge}ms old)`);
            metaPollId = savedPollId;
            shouldCreateNewMetaPoll = false;
          } else {
            console.log(`🕒 Existing metapoll expired: ${savedPollId} (${pollAge}ms old)`);
          }
        }
        
        // Create a new metapoll ID if needed
        if (shouldCreateNewMetaPoll) {
          metaPollId = `meta-${currentTeam}-${now}-decision-2`;
          // Save this as the active metapoll for this team
          localStorage.setItem(existingMetaPollKey, `${metaPollId}|${now}`);
          console.log(`🆕 Created new metapoll: ${metaPollId}`);
          
          // Add a meta decision entry with explicit voting flags
          const metaDecisionMsg = {
            team: currentTeam,
            player: 'Game',
            message: "Team must decide: continue guessing or end turn?",
            timestamp: now,
            isVoting: true, // CRITICAL: Mark as voting message
            voteType: 'meta_decision',
            metaOptions: ['continue', 'end_turn'], // Used by the renderMessage function
            pollId: metaPollId, // CRITICAL: Add explicit poll ID for easy matching with votes 
            messageId: metaPollId // Also use same ID as messageId for redundancy
          };
          
          setLocalDiscussion(prev => [...prev, metaDecisionMsg]);
          
          // Send via WebSocket for real-time updates
          if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({
              ...metaDecisionMsg,
              type: 'discussion',
              gameId: Number(id),
              pollId: metaPollId,
              messageId: metaPollId
            }));
          }
          
          // Request AI models to vote on continue/end turn
          fetch(`/api/games/${id}/meta/discuss`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: "Should we continue guessing or end turn?",
              team: currentTeam,
              triggerVoting: true,
              pollId: metaPollId,
              messageId: metaPollId,
              isVoting: true,
              voteType: 'meta_decision'
            })
          }).catch(err => console.error("Error triggering AI meta vote:", err));
        } else {
          console.log(`🔄 Using existing poll ${metaPollId} instead of creating a duplicate`);
        }
        
        // Always create a meta vote display in the UI for humans to vote
        setIsVotingActive(true);
      }
      
      return data;
    },
    
    onSuccess: (data) => {
      // Force refresh game data to update UI
      queryClient.invalidateQueries({ 
        queryKey: [`/api/games/${id}`],
        refetchType: 'active'
      });
    },
    
    onError: (error) => {
      console.error("Error making guess:", error);
      toast({
        title: "Error making guess",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  // UNIFIED TURN MANAGEMENT: Single source of truth for all turn-related operations
  useEffect(() => {
    if (!game) return;
    
    // Central variable to track turn change in progress
    let turnChangeInProgress = false;
    
    // TIMER SYNCHRONIZATION: Sync client timer with server timer on each game update
    if (game.currentTurnStartTime) {
      const turnStart = new Date(game.currentTurnStartTime).getTime();
      const now = Date.now();
      const elapsedSeconds = Math.floor((now - turnStart) / 1000);
      const timeLeft = Math.max(0, 60 - elapsedSeconds); // Fixed 60 second turn timer
      
      // Only update if significantly out of sync to avoid jitter
      if (Math.abs(timeLeft - turnTimer) > 2) {
        console.log(`⏰ Timer sync: local=${turnTimer}, server=${timeLeft}`);
        setTurnTimer(timeLeft);
      }
    }
    
    // CRITICAL FUNCTION: Handles turn switching with multiple redundant methods
    const forceTurnChange = (reason: string) => {
      if (turnChangeInProgress) return; // Prevent duplicate turn changes
      
      turnChangeInProgress = true;
      const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";
      const nextTeam = game.currentTurn === "red_turn" ? "blue" : "red";
      const nextTurnState = game.currentTurn === "red_turn" ? "blue_turn" : "red_turn";
      
      console.log(`🔄 FORCE TURN CHANGE: ${currentTeam} → ${nextTeam}, reason: ${reason}`);
      
      // If timer expired, immediately terminate any active meta votes without resolution
      if (reason === 'timer_expired') {
        console.log('⏰ Timer expired - terminating any active meta votes');
        
        // Immediately update UI state to reflect voting termination
        setIsVotingActive(false);
        setVotingInProgress(false);
        setDisplayedPolls(new Set()); // Clear all displayed polls
        
        // Clean up active meta poll in localStorage to prevent duplicates
        const redPollKey = `active-metapoll-red`;
        const bluePollKey = `active-metapoll-blue`;
        localStorage.removeItem(redPollKey);
        localStorage.removeItem(bluePollKey);
        
        // Clear poll message tracking maps to prevent duplicates on next polls
        localStorage.removeItem('pollMessageIdMap');
        localStorage.removeItem('pollIdDeduplicationMap');
        
        // Send a clear notification via WebSocket that voting was terminated due to time
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(JSON.stringify({
            type: 'discussion',
            gameId: Number(game.id),
            team: currentTeam,
            player: 'Game',
            content: `⏱️ Time expired! Turn ended automatically.`,
            message: `⏱️ Time expired! Turn ended automatically.`,
            timestamp: Date.now(),
            isSystemMessage: true
          }));
        }
      }
      
      // THREE PARALLEL METHODS to ensure the turn absolutely changes:
      
      // METHOD 1: Meta vote with high priority flag (most reliable way)
      const metaVotePromise = fetch(`/api/games/${game.id}/meta/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'Game',
          team: currentTeam,
          action: 'end_turn',
          timerExpired: reason === 'timer_expired',
          highPriority: true,
          terminateActivePolls: reason === 'timer_expired', // Add flag to terminate active polls
          timestamp: Date.now()
        })
      })
      .then(res => res.json())
      .catch(err => {
        console.error('Meta vote method failed, trying backup methods:', err);
        return { error: true };
      });
      
      // METHOD 2: Direct PATCH to game state (backup method)
      const directPatchPromise = fetch(`/api/games/${game.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          currentTurn: nextTurnState,
          currentTurnStartTime: new Date(),
          _timestamp: Date.now(),
          _forceTimerSwitch: true,
          forceTimerExpiration: reason === 'timer_expired'
        })
      })
      .then(res => res.json())
      .catch(err => {
        console.error('Direct PATCH method failed:', err);
        return { error: true };
      });
      
      // METHOD 3: WebSocket broadcast (notification method)
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({
          type: 'turn_change',
          from: currentTeam,
          to: nextTeam,
          reason: reason,
          gameId: Number(game.id),
          timestamp: Date.now(),
          forced: true,
          highPriority: true
        }));
      }
      
      // Process all turn change attempts and reset client state
      Promise.all([metaVotePromise, directPatchPromise])
        .then(() => {
          console.log('✅ All turn change mechanisms executed');
          
          // RESET ALL CLIENT STATE for a clean transition
          setLastClue(null);
          setIsDiscussing(false);
          
          // Ensure all voting related state is cleared
          setIsVotingActive(false);
          setVotingInProgress(false);
          
          // Only reset timer if it's not a spymaster giving a clue
          // Check if we're transitioning from a game state without a clue to receiving a clue
          const isSpymasterGivingClue = reason === 'spymaster_clue' || 
                localStorage.getItem(`game-${game.id}-next-action`) === 'request_clue';
          
          if (!isSpymasterGivingClue) {
            setTurnTimer(60); // Reset timer only when not giving clue
          }
          
          // Clear displayedPolls when turn changes to allow fresh polls in the new turn
          setDisplayedPolls(new Set());
          
          aiTurnInProgress.current = false;
          processedGameState.current = false;
          aiDiscussionTriggered.current = false;
          setVotedOnWords({});
          setVotedOnMeta({});
          setWordVoteCounts({});
          
          // Force refresh all game data
          queryClient.invalidateQueries({ 
            queryKey: [`/api/games/${game.id}`],
            refetchType: 'active'
          });
          
          // Release the lock after a short delay
          setTimeout(() => {
            turnChangeInProgress = false;
          }, 2000);
          
          // Add final verification after a delay to GUARANTEE the turn changed
          setTimeout(() => {
            fetch(`/api/games/${game.id}`)
              .then(res => res.json())
              .then(currentGame => {
                if (currentGame.currentTurn === game.currentTurn) {
                  console.error("🚨 EMERGENCY: Turn did not change, using final failsafe method");
                  
                  // LAST RESORT: Emergency direct update with special flag
                  fetch(`/api/games/${game.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                      currentTurn: nextTurnState,
                      currentTurnStartTime: new Date(),
                      _EMERGENCY_TURN_CHANGE: true
                    })
                  }).then(() => {
                    // Hard reset of all local state to ensure clean UI
                    setLocalDiscussion([]);
                    setVotedOnWords({});
                    setVotedOnMeta({});
                    setWordVoteCounts({});
                    setDisplayedPolls(new Set<string>());
                    
                    // Force refetch one final time
                    queryClient.invalidateQueries({ 
                      queryKey: [`/api/games/${game.id}`],
                      refetchType: 'active'
                    });
                  });
                }
              });
          }, 3000);
        });
    };
    
    // Main timer countdown interval 
    const timerInterval = setInterval(() => {
      setTurnTimer(prev => {
        // Timer already at 0, keep it at 0
        if (prev <= 0) {
          // If timer is already at 0, that means it expired but turn didn't change
          // Force the turn change again as a failsafe
          if (!turnChangeInProgress) {
            // When timer expires, immediately end any ongoing meta voting process
            forceTurnChange('timer_expired');
          }
          return 0;
        }
        
        // Warning at 5 seconds
        if (prev === 5) {
          if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({
              type: 'discussion',
              gameId: Number(game.id),
              team: game.currentTurn === "red_turn" ? "red" : "blue",
              player: 'Game',
              content: `⚠️ 5 seconds remaining!`,
              message: `⚠️ 5 seconds remaining!`,
              timestamp: Date.now(),
              timeWarning: true
            }));
          }
        }
        
        // CRITICAL: When timer hits 1, trigger the turn change before it reaches 0
        if (prev === 1 && !turnChangeInProgress) {
          forceTurnChange('timer_expired');
        }
        
        // Normal countdown
        return prev - 1;
      });
    }, 1000);
    
    // Clean up on unmount
    return () => {
      clearInterval(timerInterval);
    };
  }, [game?.id, game?.currentTurn, game?.currentTurnStartTime]);

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
    
    // Add message to local state immediately
    const newEntry: TeamDiscussionEntry = {
      team: currentTeam,
      player: 'human',
      message: discussionInput,
      timestamp: Date.now(),
      confidences: [], // Add missing required property
      suggestedWords: [] // Add missing required property
    };
    
    // Update local state first for immediate UI update
    setLocalDiscussion(prev => [...prev, newEntry]);
    
    // Clear the input right away
    setDiscussionInput("");
    
    // Send via WebSocket for realtime updates
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: 'discussion',
        content: discussionInput,
            team: currentTeam,
        gameId: Number(id),
        timestamp: Date.now()
      }));
    }
    
    // Also make API call as backup
    apiRequest("POST", `/api/games/${id}/meta/discuss`, {
      message: discussionInput,
      team: currentTeam
    }).catch(error => {
      toast({
        title: "Failed to send message",
        description: error.message,
        variant: "destructive"
      });
    });
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
      if (game?.assassin === word) return "text-white";
      return game?.revealedCards?.includes(word) ? "text-white" : "text-black";
    }
    return game?.revealedCards?.includes(word) ? "text-white" : "text-gray-900";
  };
  
  // State for toggling model icons and confidence circles
  const [showModelIcons, setShowModelIcons] = useState(true);
  
  // Save model icons preference
  useEffect(() => {
    try {
      localStorage.setItem("showModelIcons", JSON.stringify(showModelIcons));
    } catch (e) {
      console.error("Could not save showModelIcons preference", e);
    }
  }, [showModelIcons]);
  
  // Function to get model votes for a word - processed from teamDiscussion/wordVoteCounts
  const getModelVotesForWord = (word: string) => {
    // Collect model votes from discussion entries
    const allVotes: {model: string; vote: boolean; confidence: number}[] = [];
    
    // Only get votes from the current team
    const currentTeam = game?.currentTurn === "red_turn" ? "red" : "blue";
    const recentMessages = game?.teamDiscussion?.slice(-30) || [];
    
    // Track highest confidence vote for each unique model ID
    const modelVoteMap: Record<string, {confidence: number, vote: boolean}> = {};
    
    // Process messages to find votes, filtering by current team only
    recentMessages.forEach(entry => {
      // Skip if entry is not from current team
      if (entry.team !== currentTeam) return;
      
      if (!entry.suggestedWords || entry.suggestedWords.length === 0) return;
      
      // Get the index of this word in the suggestedWords array
      const wordIndex = entry.suggestedWords.indexOf(word);
      if (wordIndex === -1) return; // Word not found in this message
      
      // Get confidence for this word
      const confidence = entry.confidences && wordIndex < entry.confidences.length ? 
        entry.confidences[wordIndex] : 0.5;
      
      // Preserve the full model ID (including any unique identifier)
      const fullModelId = entry.player;
      
      // Only keep the highest confidence vote for each unique model ID
      if (!modelVoteMap[fullModelId] || confidence > modelVoteMap[fullModelId].confidence) {
        modelVoteMap[fullModelId] = {
          confidence: confidence,
          vote: true
        };
      }
    });
    
    // Convert map to array of votes (one per unique model ID with highest confidence)
    Object.entries(modelVoteMap).forEach(([fullModelId, voteInfo]) => {
      allVotes.push({
        model: fullModelId,
        vote: voteInfo.vote,
        confidence: voteInfo.confidence
      });
    });
    
    return allVotes;
  };

  // ENHANCED: Much more aggressive detection of voting activity with auto-creation of meta decisions
  useEffect(() => {
    if (!game) return;

    // Check a larger window of recent messages for voting activity
    const recentMessages = game.teamDiscussion?.slice(-10) || [];
    
    // Look for ANY indicators that voting should be active
    const hasVotingMessages = recentMessages.some(entry => 
      entry.isVoting === true || 
      entry.voteType || 
      entry.action === "vote" ||
      // @ts-ignore - Handle metaOptions which may not be in the type
      entry.metaOptions ||
      (entry.message && entry.message.includes("continue guessing or end turn"))
    );
    
    // CRITICAL: Check for recent correct guesses without explicit voting
    const correctGuessMessages = recentMessages.filter(entry => 
      entry.player === 'Game' && 
      entry.message?.includes('Guessed:') && 
      !entry.message?.includes('wrong') &&
      !entry.message?.includes('neutral') &&
      !entry.message?.includes('opponent') &&
      !entry.message?.includes('assassin')
    );
    
    const hasCorrectGuess = correctGuessMessages.length > 0;
    
    // Find the most recent correct guess
    let mostRecentCorrectGuess = null;
    if (hasCorrectGuess) {
      mostRecentCorrectGuess = correctGuessMessages[correctGuessMessages.length - 1];
    }
    
    console.log(`🔍 Voting detection check: hasVotingMessages=${hasVotingMessages}, hasCorrectGuess=${hasCorrectGuess}`);
    
    // If we have voting messages OR a recent correct guess, set voting active
    if (hasVotingMessages || hasCorrectGuess) {
      setIsVotingActive(true);
      setVotingInProgress(true);
      console.log(`✅ Voting state ACTIVATED`);
      
      // If we have a correct guess but no meta decision message after it, create one
      if (hasCorrectGuess && !hasVotingMessages && mostRecentCorrectGuess) {
        // Get timestamp of most recent correct guess
        const guessTimestamp = mostRecentCorrectGuess.timestamp || 0;
        
        // Check if any meta decision exists after this guess
        const hasMetaDecisionAfterGuess = recentMessages.some(entry => 
          entry.isVoting === true && 
          // @ts-ignore - Allow comparison with meta_decision
          entry.voteType === 'meta_decision' && 
          entry.timestamp > guessTimestamp
        );
        
        if (!hasMetaDecisionAfterGuess) {
          console.log(`🚨 CORRECT GUESS WITHOUT META DECISION DETECTED - CREATING ONE`);
          
          // Get current team
          const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";
          
          // Create meta decision message
          const metaDecisionMsg = {
            team: currentTeam,
            player: 'Game',
            message: "Team must decide: continue guessing or end turn?",
            timestamp: Date.now(),
            isVoting: true,
            voteType: 'meta_decision',
            metaOptions: ['continue', 'end_turn']
          };
          
          // Add to local discussion immediately
          setLocalDiscussion(prev => [...prev, metaDecisionMsg]);
          
          // Send to server to ensure AI models vote on it
          fetch(`/api/games/${game.id}/meta/discuss`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: "Should we continue guessing or end turn?",
              team: currentTeam,
              triggerVoting: true,
              isVoting: true,
              voteType: 'meta_decision',
              forceMeta: true
            })
          }).catch(err => console.error("Error creating meta decision:", err));
          
          // Force refresh game data
          queryClient.invalidateQueries({ 
            queryKey: [`/api/games/${game.id}`],
            refetchType: 'active'
          });
        }
      }
    }
  }, [game?.teamDiscussion, game?.id, game?.currentTurn]);

  // Add this useEffect to auto-scroll to the bottom whenever messages change
  useEffect(() => {
    if (scrollAreaRef.current) {
      // Set a short timeout to ensure content is rendered before scrolling
      setTimeout(() => {
        const scrollContainer = scrollAreaRef.current;
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      }, 50);
    }
  }, [game?.teamDiscussion]);
  
  // Basic check for high-confidence words to guess
  useEffect(() => {
    if (!game || !lastClue) return;
    
    // Check for words that have enough votes
    const checkVotesInterval = setInterval(() => {
      // Find the word with most votes
      let bestWord = '';
      let highestVotes = 0;
      
      Object.entries(wordVoteCounts).forEach(([word, info]) => {
        if (!game.revealedCards.includes(word) && info.count > highestVotes) {
          bestWord = word;
          highestVotes = info.count;
        }
      });
      
      // Auto-guess if we have 2+ votes
      if (bestWord && highestVotes >= 2) {
        console.log(`Auto-guessing: ${bestWord}`);
        makeGuess.mutate(bestWord);
        clearInterval(checkVotesInterval);
      }
    }, 3000);
    
    return () => clearInterval(checkVotesInterval);
  }, [game, wordVoteCounts, lastClue, makeGuess]);

  // Ref for auto-guessing timeout
  const autoGuessTimeoutRef = useRef<NodeJS.Timeout>();

  // CRITICAL: Direct aggressive auto-guessing logic - completely rewritten for reliability
  useEffect(() => {
    // Only run if we have a game with discussion and a current clue
    if (!game?.teamDiscussion || !lastClue) return;
    
    const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";
    
    // Create a cache key to prevent re-processing
    const gameStateKey = `${game.id}-${game.currentTurn}-${game.teamDiscussion.length}`;
    
    // Dedicated logging for this critical function
    console.log(`⚡ AGGRESSIVE AUTO-GUESSER ACTIVATED - Game state ${gameStateKey}`);
    
    // STEP 1: Get all unrevealed words for this team
    const unrevealedWords = game.words.filter(word => !game.revealedCards.includes(word));
    
    // Current team messages only, from most recent
    const teamMessages = game.teamDiscussion
      .filter(msg => msg.team === currentTeam)
      .sort((a, b) => b.timestamp - a.timestamp);
    
    // Quickly extract and track ALL suggested words with their stats
    const wordSuggestions = new Map();
    
    // First pass - collect all words and their data
    teamMessages.forEach(msg => {
      if (!msg.suggestedWords || msg.suggestedWords.length === 0) return;
      
      msg.suggestedWords.forEach((word: string, index: number) => {
        // Skip meta options and revealed cards
        if (word === "CONTINUE" || word === "END TURN" || game.revealedCards.includes(word)) return;
        
        // Get confidence for this word
        const confidence = msg.confidences && index < msg.confidences.length 
          ? msg.confidences[index] 
          : 0.5;
        
        // Initialize if needed
        if (!wordSuggestions.has(word)) {
          wordSuggestions.set(word, {
            count: 0,
            totalConfidence: 0,
            sources: new Set(),
            maxConfidence: 0
          });
        }
        
        // Update stats
        const stats = wordSuggestions.get(word);
        stats.count++;
        stats.totalConfidence += confidence;
        stats.sources.add(msg.player);
        
        // Track highest confidence
        if (confidence > stats.maxConfidence) {
          stats.maxConfidence = confidence;
        }
      });
    });
    
    // STEP 2: Find the absolute best word to guess
    const bestCandidates = Array.from(wordSuggestions.entries())
      .map(([word, stats]) => ({
        word,
        count: stats.count,
        sources: stats.sources.size,
        avgConfidence: stats.totalConfidence / stats.count,
        maxConfidence: stats.maxConfidence
      }))
      .filter(c => c.avgConfidence > 0.6) // Only consider high confidence candidates
      .sort((a, b) => {
        // Multi-factor sorting (in priority order)
        if (a.sources !== b.sources) return b.sources - a.sources; // Most sources first
        if (a.count !== b.count) return b.count - a.count; // Most mentions first
        return b.avgConfidence - a.avgConfidence; // Highest confidence first
      });
    
    // Log potential candidates
    console.log(`🎲 Auto-guess candidates (${bestCandidates.length}):`, 
      bestCandidates.map(c => `${c.word} (${c.avgConfidence.toFixed(2)} from ${c.sources} sources)`).join(", ")
    );
    
    // STEP 3: Direct auto-guess if we have a very strong candidate
    if (bestCandidates.length > 0) {
      const bestWord = bestCandidates[0];
      
      // Check if this is a very high confidence word
      const isVeryHighConfidence = 
        (bestWord.sources >= 2 && bestWord.avgConfidence > 0.7) || // Multiple sources with high confidence
        (bestWord.count >= 3 && bestWord.avgConfidence > 0.65) || // Many mentions with good confidence
        (bestWord.maxConfidence > 0.85); // Any extremely high confidence mention
      
      // Auto-guess immediately if very high confidence (without voting)
      if (isVeryHighConfidence) {
        console.log(`🎯 CRITICAL: Direct auto-guess initiated for high-confidence word: ${bestWord.word}`);
        
        // Add to word votes for tracking
        setWordVoteCounts(prev => ({
          ...prev,
          [bestWord.word]: {
            count: 10, // Force over threshold
            threshold: 2,
            voters: [...Array.from(wordSuggestions.get(bestWord.word).sources), 'Game', 'autoVote']
          }
        }));
        
        // Announcement message
        const autoGuessMsg: TeamDiscussionEntry = {
          team: currentTeam as "red" | "blue",
          player: 'Game',
          message: `Auto-guessing high confidence word: ${bestWord.word}`,
          timestamp: Date.now(),
          suggestedWords: [bestWord.word],
          confidences: [0.95]
        };
        
        // Update chat
        setLocalDiscussion(prev => [...prev, autoGuessMsg]);
        
        // WebSocket notification
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(JSON.stringify({
            ...autoGuessMsg,
            type: 'discussion',
            gameId: Number(game.id)
          }));
        }
        
        // EXECUTE THE GUESS with a short delay
        autoGuessTimeoutRef.current = setTimeout(() => {
          // Final check that word hasn't been guessed
          if (!game.revealedCards.includes(bestWord.word)) {
            console.log(`🔥 EXECUTING direct auto-guess for: ${bestWord.word}`);
            makeGuess.mutate(bestWord.word);
          }
        }, 1000);
      } 
      // Otherwise trigger voting for a good candidate
      else if (bestWord.avgConfidence > 0.65 && !displayedPolls.has(bestWord.word)) {
        console.log(`🗳️ Starting vote for candidate word: ${bestWord.word}`);
        
        // Add to displayed polls
        setDisplayedPolls(prev => new Set([...prev, bestWord.word]));
        
        // Create vote message
        const voteMsg: TeamDiscussionEntry = {
          team: currentTeam as "red" | "blue",
          player: 'Game',
          message: `Team vote suggested for word: ${bestWord.word}`,
          timestamp: Date.now(),
          suggestedWords: [bestWord.word],
          confidences: [bestWord.avgConfidence],
          isVoting: true
        };
        
        // Update chat
        setLocalDiscussion(prev => [...prev, voteMsg]);
        
        // WebSocket notification
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(JSON.stringify({
            ...voteMsg,
            type: 'discussion',
            gameId: Number(game.id)
          }));
        }
        
        // Add a system vote to get voting started
        fetch(`/api/games/${game.id}/ai/vote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'Game',
            team: currentTeam,
            word: bestWord.word
          })
        })
        .then(res => res.json())
        .then(data => {
          console.log("System vote submitted, result:", data);
          
          // If threshold reached, make the guess
          if (data.thresholdReached) {
            const guessMsg: TeamDiscussionEntry = {
              team: currentTeam as "red" | "blue",
              player: 'Game',
              message: `Threshold reached, guessing: ${bestWord.word}`,
              timestamp: Date.now() + 1,
              suggestedWords: [],
              confidences: []
            };
            
            setLocalDiscussion(prev => [...prev, guessMsg]);
            
            // Remove the word from displayedPolls when threshold is reached
            // to allow new polls to be created for this word in the future
            setDisplayedPolls(prev => {
              const newPolls = new Set([...prev]);
              newPolls.delete(bestWord.word);
              return newPolls;
            });
            
            // Make the guess
            setTimeout(() => {
              if (!game.revealedCards.includes(bestWord.word)) {
                makeGuess.mutate(bestWord.word);
              }
            }, 800);
          }
        });
      }
    }
    
    // Cleanup
    return () => {
      if (autoGuessTimeoutRef.current) {
        clearTimeout(autoGuessTimeoutRef.current);
      }
    };
  }, [game?.id, game?.teamDiscussion?.length, game?.currentTurn, game?.revealedCards, lastClue]);
  
  // Enhanced helper function to handle voting on a word or meta action
  const handleWordVote = (word: string, currentTeam: string) => {
    console.log(`Voting for word: ${word} as team ${currentTeam}`);
    
    // Special case for meta-voting options (CONTINUE or END TURN)
    if (word === "CONTINUE" || word === "END TURN") {
      // Use our meta voting handler with the special word
      handleMetaVote("continue", word);
      return;
    }
    
    // Prevent double voting - track that this player has voted for this word
    let alreadyVoted = false;
    
    setVotedOnWords(prev => {
      // Initialize if first vote for this word
      if (!prev[word]) {
        prev[word] = new Set(['human']);
      } else if (prev[word].has('human')) {
        // Already voted
        alreadyVoted = true;
        return prev;
      } else {
        // Add this player's vote
        prev[word].add('human');
      }
      return { ...prev };
    });
    
    if (alreadyVoted) {
      toast({
        title: "Already voted",
        description: "You've already voted for this word",
        variant: "destructive"
      });
      return;
    }
    
    // Update our local vote tracking
    setWordVoteCounts(prev => {
      if (!prev[word]) {
        // First vote for this word
        return {
          ...prev,
          [word]: { 
            count: 1,
            threshold: 2, // Need at least 2 votes
            voters: ['human']
          }
        };
      } else if (!prev[word].voters.includes('human')) {
        // Add this player's vote if not already counted
        return {
          ...prev,
          [word]: {
            count: prev[word].count + 1,
            threshold: prev[word].threshold,
            voters: [...prev[word].voters, 'human']
          }
        };
      }
      return prev;
    });
    
    // Create a vote object for the server
    const vote = {
      model: 'human',
      team: currentTeam,
      word
    };
    
    // Add the vote message to the discussion
    const voteMessage = {
      team: currentTeam,
      player: 'human',
      message: `Voted to guess: ${word}`,
      timestamp: Date.now(),
      suggestedWords: [word],
      confidences: [0.9]
    };
    
    setLocalDiscussion(prev => [...prev, voteMessage]);
    
    // Send via WebSocket for real-time updates
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        ...voteMessage,
        type: 'discussion',
        gameId: Number(game?.id)
      }));
    }
    
    // Immediate UI feedback
    toast({
      title: "Vote submitted",
      description: `You voted for the word: ${word}`,
    });
    
    // Use our existing mutation to send the vote
    queryClient.invalidateQueries({ queryKey: [`/api/games/${game?.id}`] });
    
    // Send the vote to the server
    fetch(`/api/games/${game?.id}/ai/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(vote)
    })
    .then(response => response.json())
    .then(data => {
      console.log("Vote submitted successfully:", data);
      
      // Check if we've reached the voting threshold to make a guess
      if (data.thresholdReached || data.voteCount >= 2) {
        console.log(`✓ Vote threshold reached for ${word}!`);
        
        // Check if we have enough local votes to trigger a guess
        const voteInfo = wordVoteCounts[word];
        if (voteInfo && voteInfo.count >= voteInfo.threshold) {
          // We have enough votes, so make the guess automatically
          console.log(`🎯 Auto-guessing word ${word} based on votes`);
          
          // Announce the auto-guess
          const autoGuessMsg = {
            team: currentTeam,
            player: 'Game',
            message: `Auto-guessing ${word} based on team votes!`,
            timestamp: Date.now(),
            suggestedWords: [word],
            confidences: [0.95]
          };
          
          setLocalDiscussion(prev => [...prev, autoGuessMsg]);
          
          // Slight delay to allow UI to update
          setTimeout(() => {
            if (!game?.revealedCards.includes(word)) {
              makeGuess.mutate(word);
            }
          }, 1000);
        }
      }
      
      // Force refresh game data
      queryClient.invalidateQueries({ 
        queryKey: [`/api/games/${game?.id}`],
        refetchType: 'active'
      });
    })
    .catch(error => {
      console.error("Error submitting vote:", error);
      toast({
        title: "Failed to submit vote",
        description: "An error occurred while voting",
        variant: "destructive"
      });
    });
  };

  // Completely rewritten renderTeamDiscussion function with simplicity and reliability in mind
  const renderTeamDiscussion = () => {
    if (!game) return null;
    
    // CRITICAL: Merge all sources of messages and deduplicate for maximum reliability
    const allMessages = [...(game.teamDiscussion || []), ...(localDiscussion || [])];
    
    // Custom hash function to better identify unique messages
    const getMessageHash = (msg: any): string => {
      if (!msg) return '';
      
      // Extract key fields to identify the message
      const timestamp = msg.timestamp || 0;
      const player = msg.player || '';
      const message = msg.message || msg.content || '';
      
      // For meta polls, use pollId to ensure uniqueness
      if (msg.voteType === 'meta_decision' || msg.metaOptions?.length > 0) {
        const pollId = msg.pollId || `meta-${msg.team}-${timestamp}`;
        return `metapoll-${pollId}`;
      }
      
      // Include a bit of message content to better distinguish messages
      return `${timestamp}-${player}-${message.slice(0, 10)}`;
    };
    
    // Use a Map to deduplicate messages with a better hash function
    const messageMap = new Map();
    allMessages.forEach(msg => {
      // Process each message to ensure all fields are populated
      const processedMsg = {
        ...msg,
        message: msg.message || msg.content || '', // Ensure message field is populated
        confidences: msg.confidences || [msg.confidence || 0.5], // Ensure confidences array
        suggestedWords: msg.suggestedWords || (msg.suggestedWord ? [msg.suggestedWord] : []) // Ensure suggestedWords array
      };
      
      const key = getMessageHash(processedMsg);
      messageMap.set(key, processedMsg);
    });
    
    // Sort by timestamp to get chronological order
    let teamDiscussion = Array.from(messageMap.values())
      .sort((a, b) => a.timestamp - b.timestamp);
      
    // CRITICAL: Filter messages to only show current team's messages
    const currentActiveTeam = game.currentTurn === "red_turn" ? "red" : "blue";
    teamDiscussion = teamDiscussion.filter(msg => msg.team === currentActiveTeam || msg.isTurnChange);
    
    //console.log(`💬 Displaying ${teamDiscussion.length} team discussion messages`);
    
    // Get current team info
    const teamColor = currentActiveTeam === "red" ? "red" : "blue";
    
    // Extract suggestion and voting messages for highlighting
    const suggestionMessages = teamDiscussion.filter(msg => 
      msg.suggestedWords && msg.suggestedWords.length > 0
    );
    const votingMessages = teamDiscussion.filter(msg => 
      msg.isVoting || msg.voteType || msg.action === "vote"
    );
    
    // Debug log
    //console.log(`📊 All messages: ${teamDiscussion.length}, With suggestions: ${suggestionMessages.length}, With voting: ${votingMessages.length}`);
    
    return (
      <Card className="h-[calc(100vh-15rem)] overflow-hidden flex flex-col">
        <CardContent className={`flex-1 p-4 flex flex-col h-full bg-${teamColor}-50/30`}>
          <div className="flex justify-between items-center mb-4">
            <h3 className={`font-bold text-lg text-${teamColor}-700`}>
              {teamColor === "red" ? "Red" : "Blue"} Team Discussion
            </h3>
            <div className="flex items-center gap-4">
              {/* Word highlighting toggle */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">Highlight Words</span>
                <Switch
                  size="sm"
                  checked={highlightGameWords}
                  onCheckedChange={setHighlightGameWords}
                  className="scale-75"
                />
              </div>
              {isDiscussing && (
                <div className="flex items-center text-amber-600">
                  <Clock className="w-4 h-4 mr-1" />
                  <span>{discussionTimer}s</span>
                </div>
              )}
            </div>
          </div>
          
          {/* Debug info */}
          <div className="bg-gray-50 p-1 mb-2 text-xs text-gray-500 rounded">
            Messages: {teamDiscussion.length} total, {suggestionMessages.length} with suggestions, {votingMessages.length} with voting
          </div>
          
          {/* Make the scroll area take remaining height */}
          <ScrollArea className="pr-4 flex-1 h-full">
            <div className="space-y-4 pb-4" ref={scrollAreaRef}>
              {teamDiscussion.length === 0 && (
                <div className="text-center p-4 text-gray-500">No discussion messages yet</div>
              )}
              
              {/* Add simple vote options if we have a clue */}
                      {/* No manual meta-vote buttons - should use Among Us style voting UI */}
              
              {/* Show all messages in chronological order with special styling for suggestions/votes */}
              {teamDiscussion.map((entry, idx) => {
                // Check message properties for styling
                const hasSuggestions = entry.suggestedWords && entry.suggestedWords.length > 0;
                const isVotingMsg = entry.isVoting || entry.voteType || entry.action === "vote";
                
                // Check if this is a meta decision message
                const isMetaDecision = entry.voteType === 'meta_decision' || entry.metaOptions?.length > 0;
                
                // Special handling for meta decisions - use the dedicated MetaPoll component
                if (isMetaDecision) {
                  return (
                    <div key={`meta-decision-${entry.timestamp}`} className="flex items-start gap-2">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-gray-100 shadow-sm">
                        <Clock className="w-5 h-5 text-gray-500" />
                      </div>
                      <div className="flex-1">
                        <div className="font-medium text-gray-800">
                          Team Decision
                          <span className="text-xs text-gray-500 ml-2">
                            {new Date(entry.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                          </span>
                          <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-800">
                            team vote
                          </span>
                        </div>
                        
                        <MetaPoll 
                          pollId={entry.pollId || `meta-${teamColor}-${entry.timestamp}-${Date.now()}`}
                          team={teamColor}
                          gameId={Number(id)}
                          timestamp={entry.timestamp}
                          messageId={entry.messageId || `${entry.timestamp}-${entry.player}`}
                          onVote={handleMetaVote}
                          currentClue={lastClue}
                          gameScore={{
                            red: game.redScore || 0,
                            blue: game.blueScore || 0
                          }}
                        />
                      </div>
                    </div>
                  );
                }
                
                // Create an appropriate key for React rendering
                const stableKey = `msg-${entry.timestamp}-${entry.player}-${idx}-${hasSuggestions ? 'sugg' : ''}-${isVotingMsg ? 'vote' : ''}`;
                
                return renderMessage(entry, stableKey, teamColor, hasSuggestions, isVotingMsg);
              })}
              
              {/* If any words have been suggested, display a Poll UI summarizing votes */}
              {suggestionMessages.length > 0 && (
                <div className="mt-4 border-t pt-4 border-gray-200">
                  <div className="flex justify-between items-center mb-2">
                    <h4 className="font-medium text-sm text-gray-600">Current Suggested Words:</h4>
                    <span className="text-xs text-gray-500">Word needs 2+ votes to guess</span>
                  </div>
                  <div className="space-y-2">
                    {Array.from(new Set(suggestionMessages.flatMap(msg => msg.suggestedWords))).map(word => {
                      // Get all messages mentioning this word to get player votes
                      const messagesWithWord = teamDiscussion.filter(msg => 
                        msg.suggestedWords?.includes(word)
                      );
                      
                      // Get all players who suggested or voted for this word
                      const wordVoters = new Set([
                        ...messagesWithWord.map(msg => msg.player),
                        ...(votedOnWords[word] ? Array.from(votedOnWords[word]) : [])
                      ]);
                      
                      // Calculate average confidence from suggestions
                      const confidences = messagesWithWord
                        .map(msg => {
                          const idx = msg.suggestedWords?.indexOf(word) || 0;
                          return msg.confidences && idx < msg.confidences.length ? 
                            msg.confidences[idx] : 0.5;
                        });
                      
                      const avgConfidence = confidences.length > 0 ? 
                        confidences.reduce((sum, val) => sum + val, 0) / confidences.length : 0.5;
                      
                      // Get vote information from our local tracking
                      const voteInfo = wordVoteCounts[word] || { 
                        count: wordVoters.size, 
                        threshold: 2,
                        voters: Array.from(wordVoters)
                      };
                      
                      // Check if we have enough votes to make a guess
                      const hasEnoughVotes = voteInfo.count >= voteInfo.threshold;
                      const isHighConfidence = avgConfidence > 0.6;
                      const canGuess = hasEnoughVotes && isHighConfidence;
                      
                      // Check if human has already voted
                      const humanHasVoted = votedOnWords[word]?.has('human') || false;
                      
                      return (
                        <div 
                          key={`poll-${word}`}
                          className={`p-3 rounded-lg border ${
                            canGuess ? 'border-green-500 bg-green-50' : 
                            isHighConfidence ? 'border-amber-300 bg-amber-50/30' : 
                            'border-gray-200 bg-gray-50'
                          }`}
                        >
                          <div className="flex justify-between items-center">
                            <span className="font-bold text-lg">{word}</span>
                            <span className={`text-sm px-2 py-1 rounded-full ${
                              avgConfidence > 0.7 ? 'bg-green-100 text-green-800' : 
                              avgConfidence > 0.4 ? 'bg-amber-100 text-amber-800' : 
                              'bg-red-100 text-red-700'
                            }`}>
                              Confidence: {Math.round(avgConfidence * 100)}%
                            </span>
                          </div>
                          
                          <div className="mt-3 flex justify-between items-center">
                            <div>
                              <div className="text-sm font-medium mb-1">Team votes: {voteInfo.count}/{voteInfo.threshold}</div>
                              <div className="flex -space-x-2">
                                {voteInfo.voters.map((player, i) => {
                                  const isAI = player !== 'human' && player !== 'Game';
                                  const ModelIcon = isAI && AI_MODEL_INFO[player as AIModel]?.Icon 
                                    ? AI_MODEL_INFO[player as AIModel]?.Icon 
                                    : Bot;
                                    
                                  return (
                                    <div 
                                      key={`voter-${player}-${i}`}
                                      className={`w-8 h-8 rounded-full ${
                                        player === 'human' ? 'bg-blue-100' : 
                                        isAI ? `bg-${teamColor}-100` : 'bg-gray-100'
                                      } flex items-center justify-center shadow-sm border-2 border-white`}
                                      title={player === 'human' ? 'You' : 
                                            typeof player === 'string' && player.includes('#') 
                                              ? `${baseModelName} #${player.split('#')[1]}` 
                                              : player}
                                    >
                                      {player === 'human' ? (
                                        <span className="text-sm">👤</span>
                                      ) : isAI ? (
                                        <ModelIcon className="w-5 h-5" />
                                      ) : (
                                        <Clock className="w-4 h-4 text-gray-500" />
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                            
                            <div className="flex gap-2">
                              {/* Auto-guessing indicator - no manual buttons needed */}
                              <div className="text-xs px-2 py-1 rounded-md">
                                {canGuess ? (
                                  <span className="text-green-700 bg-green-100 px-2 py-1 rounded">
                                    Auto-guessing...
                                  </span>
                                ) : (
                                  <span className="text-amber-700 bg-amber-50 px-2 py-1 rounded animate-pulse">
                                    Collecting votes ({voteInfo.count}/{voteInfo.threshold})
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                          
                          {/* Progress bar to show voting progress */}
                          <div className="mt-2 h-1.5 w-full bg-gray-200 rounded-full overflow-hidden">
                            <div 
                              className={`h-full ${
                                canGuess ? "bg-green-500" : "bg-amber-500"
                              }`}
                              style={{ width: `${Math.min(100, (voteInfo.count / voteInfo.threshold) * 100)}%` }}
                            ></div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
          
          {/* Input field for human players */}
          <div className="mt-4 flex gap-2">
            <input
              type="text"
              value={discussionInput}
              onChange={(e) => setDiscussionInput(e.target.value)}
              placeholder="Type your thoughts..."
              className="flex-1 border rounded px-3 py-2"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && discussionInput.trim()) {
                  sendDiscussion();
                }
              }}
              disabled={votingInProgress} // CRITICAL FIX: Disable input during voting
            />
            <Button 
              onClick={sendDiscussion}
              disabled={!discussionInput.trim() || votingInProgress} // CRITICAL FIX: Disable button during voting
              className={`bg-${teamColor}-600 hover:bg-${teamColor}-700 text-white ${votingInProgress ? 'opacity-50' : ''}`}
            >
              Send
            </Button>
            {votingInProgress && (
              <div className="text-sm text-amber-600 absolute -bottom-6 left-0 right-0 text-center">
                Voting in progress. Discussion paused.
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    );
  };

  // Enhanced Helper function to render a single message with formatting support
  const renderMessage = (
    entry: TeamDiscussionEntry, 
    key: string, 
    teamColor: string, 
    hasSuggestions = false, 
    isVotingMsg = false
  ) => {
    const isAI = entry.player !== 'Game' && entry.player !== 'human';
    // Extract base model for icon lookup but preserve the full ID
    const baseModelName = typeof entry.player === 'string' && entry.player.includes('#') 
      ? entry.player.split('#')[0] 
      : entry.player;
    const ModelIcon = isAI && AI_MODEL_INFO[baseModelName as AIModel]?.Icon 
      ? AI_MODEL_INFO[baseModelName as AIModel]?.Icon 
      : Bot;
    
    // Determine actual message team color (red or blue)
    const msgTeamColor = entry.team === "red" ? "red" : "blue";
    // Is this message from the current team or opponent?
    const isCurrentTeam = entry.team === (game?.currentTurn === "red_turn" ? "red" : "blue");
    
    // Add opacity for opponent team messages
    const opacityClass = isCurrentTeam ? "opacity-100" : "opacity-70";
    
    // Add special classes for suggestion/voting messages
    const specialClassNames = hasSuggestions ? "border-amber-300 shadow-sm" 
      : isVotingMsg ? "border-blue-300 shadow-md" 
      : "";
    
    // Check if this is a turn change message (for stronger visual separation)
    const isTurnChangeMsg = entry.message?.includes("TEAM'S TURN") || 
      // @ts-ignore - Property may not exist on type but used in logic
      entry.isTurnChange;
    const isTurnStart = entry.message?.includes("New Discussion Begins");

    // Format message with bold text and line breaks
    const formatMessage = (message: string, forceHighlight: boolean = false) => {
      if (!message) return "";
      
      // First handle line breaks and spaces
      let formatted = message;
      
      // Handle different types of line break notations
      formatted = formatted.replace(/\/n/g, '<br/>');
      formatted = formatted.replace(/\\n/g, '<br/>');
      formatted = formatted.replace(/\n/g, '<br/>');
      
      // Replace multiple spaces with &nbsp;
      formatted = formatted.replace(/ {2,}/g, (match) => {
        return '&nbsp;'.repeat(match.length);
      });
      
      // If word highlighting is enabled OR forceHighlight is true, highlight game words
      if ((highlightGameWords || forceHighlight) && game) {
        // Process all game words
        game.words.forEach(gameWord => {
          // Determine highlight color based on word type
          let highlightClass = '';
          
          if (game.redTeam.includes(gameWord)) {
            highlightClass = 'background-color:#ffcccc;';
          } else if (game.blueTeam.includes(gameWord)) {
            highlightClass = 'background-color:#cce5ff;';
          } else if (game.assassin === gameWord) {
            highlightClass = 'background-color:#333;color:white;';
          } else {
            // Neutral word
            highlightClass = 'background-color:#f5f5dc;';
          }
          
          // Always keep text bold but maintain its natural color (except for assassin)
          const style = `${highlightClass}font-weight:bold;padding:0 3px;border-radius:3px;`;
          
          // Create patterns that explicitly match the word in various formats
          // This will allow us to properly handle formatting characters
          
          // 1. Match **WORD** pattern (markdown bold)
          const boldPattern = new RegExp(`\\*\\*(${gameWord})\\*\\*`, 'gi');
          formatted = formatted.replace(boldPattern, `<span style="${style}">${gameWord}</span>`);
          
          // 2. Match 'WORD' pattern (single quotes)
          const singleQuotePattern = new RegExp(`'(${gameWord})'`, 'gi');
          formatted = formatted.replace(singleQuotePattern, `<span style="${style}">${gameWord}</span>`);
          
          // 3. Match "WORD" pattern (double quotes)
          const doubleQuotePattern = new RegExp(`"(${gameWord})"`, 'gi');
          formatted = formatted.replace(doubleQuotePattern, `<span style="${style}">${gameWord}</span>`);
          
          // 4. Finally, match standalone word with word boundaries
          // But be careful not to match parts of already highlighted spans
          const plainWordPattern = new RegExp(`(?<!<[^>]*)\\b(${gameWord})\\b(?![^<]*>)`, 'gi');
          formatted = formatted.replace(plainWordPattern, `<span style="${style}">${gameWord}</span>`);
        });
      }
      
      // AFTER word highlighting, handle any remaining regular formatting
      // such as non-game-word bold text
      formatted = formatted.replace(/\*\*([^<>]*?)\*\*/g, '<strong>$1</strong>');
      
      return formatted;
    };

    return (
      <motion.div
        key={key}
        initial={{ opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className={`flex items-start gap-2 ${opacityClass} ${isTurnChangeMsg ? "border-b pb-3 mb-3" : ""}`}
      >
        <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center 
          ${isAI ? `bg-${msgTeamColor}-100` : 'bg-gray-100'} shadow-sm`}
        >
          {isAI ? (
            <ModelIcon className="w-5 h-5" />
          ) : (
            entry.player === 'Game' ? 
              <Clock className="w-5 h-5 text-gray-500" /> : 
              <span className="text-sm">👤</span>
          )}
        </div>
        <div className="flex-1">
          <div className={`font-medium ${isAI ? `text-${msgTeamColor}-700` : 'text-gray-800'} flex justify-between items-center`}>
            <div>
              {isAI ? getModelDisplayName(entry.player as AIModel) : entry.player}
              <span className="text-xs text-gray-500 ml-2">
                {entry.timestamp 
                  ? new Date(entry.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
                  : new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                {!isCurrentTeam && (
                  <span className={`ml-1 text-${msgTeamColor}-500 font-medium`}>({msgTeamColor === "red" ? "RED" : "BLUE"})</span>
                )}
              </span>
            </div>
            
            {/* Special badge for important messages - now inside the flex container */}
            {(hasSuggestions || isVotingMsg) && (
              <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${
                hasSuggestions ? "bg-amber-100 text-amber-800" : 
                isVotingMsg ? "bg-blue-100 text-blue-800" : ""
              }`}>
                {hasSuggestions && entry.suggestedWords?.length ? `${entry.suggestedWords.length} word${entry.suggestedWords.length > 1 ? 's' : ''}` : ''}
                {hasSuggestions && isVotingMsg ? ' + ' : ''}
                {isVotingMsg ? 'vote' : ''}
              </span>
            )}
          </div>
          
          {/* Message content with special styling for important messages */}
          <div className={`p-2 rounded-md border
            ${isTurnStart ? "bg-purple-50 border-purple-300 font-bold text-center" : ""}
            ${isTurnChangeMsg && !isTurnStart ? "bg-gray-100 border-gray-300 text-center font-semibold" : ""}
            ${isAI && !isTurnChangeMsg ? `bg-${msgTeamColor}-50` : (!isTurnChangeMsg ? 'bg-white' : '')} 
            ${!isCurrentTeam && !isTurnChangeMsg ? `border-${msgTeamColor}-200` : (!isTurnChangeMsg ? 'border-gray-100' : '')}
            ${specialClassNames} 
            ${hasSuggestions && !isTurnChangeMsg ? `bg-amber-50/40` : ''} 
            ${isVotingMsg && !isTurnChangeMsg ? `bg-blue-50/40` : ''}
            ${
              // @ts-ignore - Property leadToMetaVote may not exist on type but used in logic
              entry.leadToMetaVote ? `bg-blue-100 shadow-md border-blue-200` : ''
            }`
          }>
            {/* Use dangerouslySetInnerHTML to render formatted message with special animation for correct guesses */}
            {/* @ts-ignore - Property animate may not exist on type but used in logic */}
            {entry.animate || entry.cardType ? (
              <motion.div
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ 
                  type: "spring", 
                  stiffness: 300, 
                  damping: 15,
                  duration: 0.5
                }}
                className={`mb-2 px-4 py-2 rounded-md font-bold text-center ${
                  // @ts-ignore - Property cardType may not exist on type but used in logic
                  entry.cardType === 'red' ? 'bg-red-100 text-red-700 border border-red-300' : 
                  // @ts-ignore - Property cardType may not exist on type but used in logic
                  entry.cardType === 'blue' ? 'bg-blue-100 text-blue-700 border border-blue-300' : 
                  'bg-gray-100 text-gray-700 border border-gray-300'
                }`}
                dangerouslySetInnerHTML={{ __html: formatMessage(entry.message) }}
              />
            ) : (
              <div 
                className="mb-1"
                dangerouslySetInnerHTML={{ __html: formatMessage(entry.message) }}
              ></div>
            )}
            
            {/* If message has suggested words, show them as clickable buttons for voting */}
            {hasSuggestions && entry.suggestedWords && entry.suggestedWords.length > 0 && !entry.suggestedWords.includes("CONTINUE") && !entry.suggestedWords.includes("END TURN") && (
              <div className="mt-2 flex flex-wrap gap-1">
                {entry.suggestedWords.map((word, idx) => {
                  // Check if this word has already been revealed
                  const isRevealed = (game?.revealedCards || []).includes(word);
                  
                  // Skip meta voting options
                  if (word === "CONTINUE" || word === "END TURN") return null;
                  
                  // Get confidence for this word
                  const wordConfidence = entry.confidences && idx < entry.confidences.length ? 
                    entry.confidences[idx] : 0.5;
                  
                  // Check if this word already has votes
                  const hasVotes = wordVoteCounts[word] && wordVoteCounts[word].count > 0;
                  const humanHasVoted = votedOnWords[word]?.has('human');
                  
                  // For revealed words, show a faded "already guessed" button
                  if (isRevealed) {
                    return (
                      <div
                        key={`word-btn-revealed-${word}-${idx}`}
                        className="text-xs py-1 px-2 h-auto bg-gray-100 border border-gray-300 rounded text-gray-400 line-through opacity-60 flex items-center"
                      >
                        {word}
                        <span className="ml-1 text-[10px] bg-gray-200 text-gray-500 px-1 rounded">
                          guessed
                        </span>
                      </div>
                    );
                  }
                  
                  // For normal unrevealed words, show clickable buttons
                  return (
                    <Button
                      key={`word-btn-${word}-${idx}`}
                      onClick={() => handleWordVote(word, teamColor)}
                      variant={humanHasVoted ? "default" : "outline"}
                      className={`text-xs py-1 px-2 h-auto ${
                        wordConfidence > 0.7 ? 
                          (humanHasVoted ? "bg-green-600" : "hover:bg-green-100 border-green-300") : 
                        wordConfidence > 0.4 ? 
                          (humanHasVoted ? "bg-amber-600" : "hover:bg-amber-100 border-amber-300") : 
                          (humanHasVoted ? "bg-gray-600" : "hover:bg-gray-100 border-gray-300")
                      }`}
                    >
                      {word} 
                      <span className="ml-1 text-[10px] opacity-80">
                        {hasVotes && wordVoteCounts[word] ? 
                          `(${wordVoteCounts[word].count}/${wordVoteCounts[word].threshold})` : 
                          `(${Math.round(wordConfidence * 100)}%)`
                        }
                      </span>
                      {humanHasVoted && <span className="ml-1">✓</span>}
                    </Button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </motion.div>
    );
  };

  const renderGameLog = () => {
    // CRITICAL FIX: Include ALL important game events (clues, guesses, AND meta votes)
  // This time create a deep clone so we can add local meta_vote entries to it
  // First get all relevant entries
  // Process game history entries to ensure team is correctly set
  const gameHistoryEntries = (game?.gameHistory?.filter(entry => entry.type === "meta_vote") || [])
    .map(entry => ({
      ...entry,
      // Ensure team is set correctly - use turn field as primary source for meta votes
      team: entry.turn || entry.team,
      // Ensure vote action is set for meta votes
      voteAction: entry.voteAction || (
        entry.action?.includes('continue') ? 'continue' : 
        entry.action?.includes('end turn') ? 'end_turn' : 
        'discuss_more'
      )
    }));
  
  const allEntries = [...gameLog, ...gameHistoryEntries]
    .filter(entry => 
      // Add null checks to prevent accessing properties of undefined
      (entry.action && (
        entry.action.includes("clue") || 
        entry.action.includes("Guessed") ||
        entry.action.includes("voted to") || // Include meta vote entries
        entry.action.includes("team decision") // Include team decision entries
      )) ||
      entry.result === "correct" ||
      entry.result === "wrong" ||
      entry.result === "assassin" ||
      entry.type === "meta_vote" // Explicitly include meta_vote type entries
    );
  
  // CRITICAL: Sort ALL entries chronologically by timestamp to ensure proper ordering
  // This ensures meta votes and other entries are strictly in chronological order
  const filteredLog = allEntries.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  
  // DIAGNOSTIC: Log meta votes for debugging team attribution
  const metaVotes = filteredLog.filter(entry => entry.type === "meta_vote");
  if (metaVotes.length > 0) {
    console.log(`📊 Game log contains ${metaVotes.length} meta votes:`, 
      metaVotes.map(v => ({
        team: v.team, 
        action: v.voteAction || v.action,
        player: v.player
      }))
    );
  }
    
    if (filteredLog.length === 0) {
      return (
        <div className="text-center p-6 text-gray-500">
          <div className="mb-2">📜</div>
          No game actions yet
        </div>
      );
    }

    return (
      <ScrollArea className="h-[calc(100vh-15rem)]">
        <div className="space-y-2 p-2">
          {filteredLog.slice().reverse().map((entry, i) => {
            const isRed = entry.team === "red";
            const isClue = entry.action?.includes("clue");
            const isMetaVote = entry.type === "meta_vote" || entry.action?.includes("voted to");
            const hasReasoning = entry.reasoning && typeof entry.reasoning === 'string';
            
            // Create a unique ID for tracking expanded state
            const entryId = `log-${i}-${entry.timestamp || ''}`;
            
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
                    : isMetaVote
                      ? <span className="text-l">🗳️</span>
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
                        {entry.player === "human" ? "You" : 
                         typeof entry.player === 'string' && entry.player.includes('#') 
                           ? `${entry.player.split('#')[0]} #${entry.player.split('#')[1]}`
                           : entry.player}
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
                  {entry.word && !isMetaVote && (
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
                  
                  {/* Show vote action for meta votes */}
                  {isMetaVote && entry.voteAction && (
                    <div className="mt-1">
                      <span className={`inline-block px-2 py-1 text-xs rounded ${
                        entry.voteAction === "continue" 
                          ? "bg-green-100 text-green-800" 
                          : entry.voteAction === "end_turn" 
                            ? "bg-red-100 text-red-800" 
                            : "bg-gray-100 text-gray-800"
                      }`}>
                        {entry.voteAction === "continue" ? "Continue Guessing" : 
                         entry.voteAction === "end_turn" ? "End Turn" : 
                         "Discuss More"}
                      </span>
                    </div>
                  )}
                  
                  {/* Add the collapsible reasoning section */}
                  {hasReasoning && (
                    <div className="mt-2">
                      <button
                        onClick={() => setExpandedReasonings(prev => ({
                          ...prev,
                          [entryId]: !prev[entryId]
                        }))}
                        className="flex items-center text-sm text-purple-600 hover:text-purple-800 font-medium"
                      >
                        <span>{expandedReasonings[entryId] ? "Hide" : "Show"} {isMetaVote ? "Vote" : "Spymaster's"} Reasoning</span>
                        <svg 
                          className={`ml-1 w-4 h-4 transition-transform ${expandedReasonings[entryId] ? 'rotate-180' : ''}`} 
                          fill="none" 
                          viewBox="0 0 24 24" 
                          stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                      
                      {expandedReasonings[entryId] && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.3 }}
                          className={`mt-2 p-3 ${
                            isMetaVote ? "bg-blue-100 border-l-4 border-blue-500 text-blue-800" : 
                            "bg-purple-100 border-l-4 border-purple-500 text-purple-800"
                          } text-sm rounded`}
                        >
                          <p className="font-semibold mb-1">
                            {isMetaVote ? "Vote Reasoning:" : "Spymaster's Reasoning:"}
                          </p>
                          <div dangerouslySetInnerHTML={{ 
                            __html: formatMessage(entry.reasoning || '', true) 
                          }}></div>
                        </motion.div>
                      )}
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

  // Add this helper function back
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

  // ENHANCED: Function to handle meta voting (continue/end turn) with unique model IDs
  const handleMetaVote = (action: "continue" | "end_turn" | "discuss_more", team: string, pollId?: string) => {
    console.log(`Submitting meta vote for action: ${action}, team: ${team}, pollId: ${pollId}`);
    
    // If no pollId is provided, we can't properly isolate the vote
    if (!pollId) {
      console.error("Cannot vote without a poll ID - each meta vote must have a unique identifier");
      toast({
        title: "Voting Error",
        description: "This vote couldn't be processed. Please try again.",
        variant: "destructive"
      });
      return;
    }
    
    // Create vote payload with poll ID for isolation
    const vote = {
      model: "human", 
      team,
      action,
      pollId,  // Critical: Include poll ID to ensure votes go to the correct poll
      uniqueId: `human-${Math.floor(Math.random() * 1000000)}` // Ensure each human vote is unique
    };
    
    // Send the vote
    fetch(`/api/games/${id}/meta/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(vote)
    })
    .then(response => response.json())
    .then(data => {
      console.log("Meta vote submitted:", data);
      
      // Add to local state immediately for UI feedback
      // Use pollId in the key to ensure votes are isolated
      setVotedOnMeta(prev => {
        const newState = { ...prev };
        const key = `${team}-${action}-${pollId}`; // Include pollId in key for complete isolation
        
        if (!newState[key]) {
          newState[key] = new Set();
        }
        
        newState[key].add('human');
        return newState;
      });
      
      // Mark this specific poll as voted on in localStorage
      // This is critical for ensuring we track which polls have been interacted with
      localStorage.setItem(`voted-meta-${pollId}`, 'true');
      
      // Store the turn state when this vote happened for reference
      if (game && game.turn) {
        localStorage.setItem(`meta-vote-turn-${pollId}`, String(game.turn));
      }
      
      // Clear displayedPolls to ensure new polls can be created after this vote
      // This is critical to prevent poll state unification issues
      if (action === "continue" || action === "end_turn") {
        console.log("🔄 Clearing displayed polls after meta vote to allow fresh polls");
        setDisplayedPolls(new Set());
      }
    })
    .catch(error => {
      console.error("Error submitting meta vote:", error);
      toast({
        title: "Voting Error",
        description: "Your vote couldn't be submitted. Please try again.",
        variant: "destructive"
      });
    });
  };

  // Add this useEffect to sync game.teamDiscussion with our local state
  useEffect(() => {
    if (game?.teamDiscussion) {
      setLocalDiscussion(game.teamDiscussion);
    }
  }, [game?.teamDiscussion]);

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

  // Add an initial hard reset component to clear everything on mount
  const InitialReset = () => {
    const [didReset, setDidReset] = useState(false);
    
    useEffect(() => {
      if (didReset) return;
      
      //console.log("🧹 Hard reset of game UI on initial component mount");
      
      // Clear all local state
      setLocalDiscussion([]);
      setVotedOnWords({});
      setVotedOnMeta({});
      setWordVoteCounts({});
      setDisplayedPolls(new Set<string>());
      
      setDidReset(true);
    }, [didReset]);
    
    return null; // Render nothing, just perform the effect
  };
  
  // CRITICAL FIX: Component to monitor game state and sync meta votes to UI
  const MetaVoteSync = () => {
    useEffect(() => {
      if (!game?.metaVotes) return;
      
      // Process meta votes into votedOnMeta format
      const syncMetaVotes = () => {
        console.log('Syncing meta votes to UI state...', game.metaVotes);
        
        // Get only the current team's votes for active turn  
        const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";
        const teamVotes = (game.metaVotes || []).filter(vote => vote.team === currentTeam);
        
        // CRITICAL FIX: Group votes by action AND pollId to maintain isolation
        const metaVotesMap: Record<string, Set<string>> = {};
        
        teamVotes.forEach(vote => {
          // Include pollId in the key for complete isolation
          const key = `${vote.team}-${vote.action}-${vote.pollId || 'default'}`;
          
          if (!metaVotesMap[key]) {
            metaVotesMap[key] = new Set();
          }
          
          // Add the player to the set of voters for this specific poll
          metaVotesMap[key].add(vote.player);
        });
        
        // Count votes for logging (per poll)
        const pollGroups = teamVotes.reduce((acc, vote) => {
          const pollId = vote.pollId || 'default';
          if (!acc[pollId]) acc[pollId] = { continue: 0, end_turn: 0, pollId };
          if (vote.action === 'continue') acc[pollId].continue++;
          if (vote.action === 'end_turn') acc[pollId].end_turn++;
          return acc;
        }, {} as Record<string, {continue: number, end_turn: number, pollId: string}>);
        
        // Log vote counts by poll
        Object.values(pollGroups).forEach(poll => {
          console.log(`📊 Poll ${poll.pollId}: continue=${poll.continue}, end_turn=${poll.end_turn}`);
        });
        
        // Update state with completely isolated votes
        setVotedOnMeta(metaVotesMap);
      };
      
      // Initial sync
      syncMetaVotes();
      
    }, [game?.metaVotes?.length, game?.currentTurn]);
    
    return null;
  };

  // Main component render
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-800 p-4">
      <InitialReset />
      <MetaVoteSync />
      
      {/* Shift header elements slightly left for better visual alignment */}
      <div className="mb-6 flex flex-col items-center justify-center -translate-x-4">
        {/* Animated gradient title */}
        <h1 className="text-4xl font-bold mb-4 bg-gradient-to-r from-red-600 via-blue-600 to-red-600 bg-300% text-transparent bg-clip-text drop-shadow-sm animate-gradient">
          Codenames AI
        </h1>

        {/* Score display with slight left shift */}
        <div className="flex justify-center items-center gap-6 mb-4 bg-white/20 backdrop-blur-sm py-3 px-6 rounded-xl shadow-md max-w-md w-full">
          <div className="text-red-400 font-bold text-xl drop-shadow-sm">Red: {game.redScore}</div>
          <div className={`px-6 py-2 rounded-full font-semibold shadow-sm ${
            isRedTurn ? "bg-red-500 text-white" : "bg-blue-500 text-white"
          }`}>
            {capitalizedTeam}'s Turn
          </div>
          <div className="text-blue-400 font-bold text-xl drop-shadow-sm">Blue: {game.blueScore}</div>
        </div>

        {/* Controls with the same left shift */}
        <div className="flex items-center justify-center gap-4 mb-3">
          <div className="flex items-center gap-2 bg-white/30 backdrop-blur-sm px-4 py-2 rounded-lg shadow-sm">
            <Timer className="w-4 h-4 text-white" />
            <span className={`font-medium ${turnTimer <= 10 ? 'text-red-300' : 'text-white'}`}>
              Turn: {turnTimer}s
            </span>
          </div>
          <div className="flex items-center gap-2 bg-white/30 backdrop-blur-sm px-4 py-2 rounded-lg shadow-sm">
            <Switch
              checked={isSpymasterView}
              onCheckedChange={setIsSpymasterView}
            />
            <span className="font-medium text-white">Spymaster View</span>
          </div>
          <div className="flex items-center gap-2 bg-white/30 backdrop-blur-sm px-4 py-2 rounded-lg shadow-sm">
            <Switch
              checked={showModelIcons}
              onCheckedChange={setShowModelIcons}
            />
            <span className="font-medium text-white">Show Model Icons</span>
          </div>
        </div>
      </div>

      {/* Fixed height for both panels */}
      <div className="max-w-full mx-auto grid grid-cols-1 lg:grid-cols-11 gap-4 min-h-[calc(100vh-12rem)]">
        {/* Left sidebar - Game Log with fixed height */}
        <div className="lg:col-span-3">
          <Card className="h-[calc(100vh-16rem)] bg-white/95 backdrop-blur shadow-xl overflow-hidden">
            <CardContent className="p-4 h-full flex flex-col">
              <h3 className="font-bold text-lg mb-4">Game Log</h3>
              <div className="flex-1 overflow-auto">
                {renderGameLog()}
              </div>
            </CardContent>
          </Card>
        </div>
      
        {/* Game board */}
        <div className="lg:col-span-5">
          <div className="grid grid-cols-5 gap-5">
            {game.words.map((word) => {
              // Get model votes for this word
              const modelVotes = getModelVotesForWord(word);
              
              // Calculate average confidence if there are votes
              const averageConfidence = modelVotes.length > 0 
                ? Math.round(modelVotes.reduce((acc, vote) => acc + vote.confidence * 100, 0) / modelVotes.length)
                : 0;
                
              return (
                <Card
                  key={word}
                  className={`${getCardColor(word)} cursor-pointer transition-all hover:scale-105 h-40 flex items-center justify-center shadow-md relative`}
                  onClick={() => {
                      console.log(`📌 Card clicked: ${word}`);
                      // CRITICAL: Block card clicks when voting is in progress
                      if (isVotingActive || votingInProgress) {
                        console.log(`⚠️ Card click ignored: Voting in progress`);
                        toast({
                          title: "Voting in progress",
                          description: "Wait for team decision before making next move",
                          variant: "warning",
                        });
                        return;
                      }
                      
                      if (!game.revealedCards.includes(word) && !game.gameState?.includes("win") && !aiTurnInProgress.current) {
                        console.log(`🎮 Making guess for word: ${word}`);
                        const audio = new Audio("notification.mp3");
                        audio.play();
                        makeGuess.mutate(word);
                      } else {
                        console.log(`⚠️ Card click ignored: ${
                          game.revealedCards.includes(word) ? 'already revealed' :
                          game.gameState?.includes("win") ? 'game already won' :
                          aiTurnInProgress.current ? 'AI turn in progress' : 'unknown reason'
                        }`);
                      }
                  }}
                >
                  {/* Model Icons (Top Left) - Only show in operative view when toggle is on AND card is not revealed AND game is not in win state */}
                  {!isSpymasterView && showModelIcons && modelVotes.length > 0 && !game.revealedCards.includes(word) && !game.gameState?.includes("win") && (
                    <div className="absolute -top-1 -left-1 flex">
                      <AnimatePresence>
                        {modelVotes.slice(0, 3).map((vote, index) => {
                          // Extract base model name for icon lookup but preserve full ID for uniqueness
                          const baseModelName = vote.model.split('#')[0];
                          const modelInfo = AI_MODEL_INFO[baseModelName as keyof typeof AI_MODEL_INFO] || 
                                           { name: vote.model, Icon: Bot, color: "#888888" };
                          const ModelIcon = modelInfo.Icon;
                          
                          return (
                            <motion.div 
                              key={`${vote.model}-${index}`}
                              initial={{ scale: 0, x: -5, y: -5, opacity: 0 }}
                              animate={{ scale: 1, x: index > 0 ? index * -8 : 0, y: 0, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                              transition={{ delay: index * 0.1, duration: 0.3 }}
                              style={{ zIndex: 10 - index }}
                              className="relative"
                            >
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <div
                                      className="h-9 w-9 rounded-full border-2 border-white shadow-md flex items-center justify-center" 
                                      style={{ 
                                        backgroundColor: "#ffffff",
                                        borderColor: '#e5e7eb', 
                                        boxShadow: '0 1px 3px rgba(0,0,0,0.2)' 
                                      }}
                                    >
                                      <ModelIcon 
                                        style={{ 
                                          color: vote.model === "claude-sonnet-4-5-20250929" || vote.model === "anthropic" ? "#000000" : modelInfo.color 
                                        }} 
                                        size={16} 
                                      />
                                    </div>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>
                                      {vote.model.includes('#') ? `${getModelDisplayName(vote.model.split('#')[0] as AIModel)} #${vote.model.split('#')[1]}` : getModelDisplayName(vote.model as AIModel)}: {Math.round(vote.confidence * 100)}% confidence
                                    </p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </motion.div>
                          );
                        })}
                        
                        {/* Show +X for additional models */}
                        {modelVotes.length > 3 && (
                          <motion.div 
                            initial={{ scale: 0, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{ delay: 0.3, duration: 0.3 }}
                            className="relative" 
                            style={{ marginLeft: "-8px" }}
                          >
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className="h-9 w-9 rounded-full border-2 border-white bg-white flex items-center justify-center" style={{ borderColor: '#e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }}>
                                    <span className="text-xs text-gray-700">+{modelVotes.length - 3}</span>
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <div className="text-sm">
                                    {modelVotes.slice(3).map((vote, i) => (
                                      <div key={i}>
                                        {vote.model.includes('#') ? `${getModelDisplayName(vote.model.split('#')[0] as AIModel)} #${vote.model.split('#')[1]}` : getModelDisplayName(vote.model as AIModel)}: {Math.round(vote.confidence * 100)}%
                                      </div>
                                    ))}
                                  </div>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}

                  {/* Confidence Circle (Top Right) - Only show in operative view when toggle is on AND card is not revealed AND game is not in win state */}
                  {!isSpymasterView && showModelIcons && modelVotes.length > 0 && !game.revealedCards.includes(word) && !game.gameState?.includes("win") && (
                    <div className="absolute -top-2 -right-2">
                      <ConfidenceCircle confidence={averageConfidence} />
                    </div>
                  )}
                      
                  <CardContent className="p-8 text-center flex items-center justify-center h-full w-full">
                    <span className={`font-medium text-3xl ${getTextColor(word)}`}>
                      {word}
                    </span>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>

        {/* Right sidebar - Team Discussion with matching height */}
        <div className="lg:col-span-3">
          <Card className="h-[calc(100vh-16rem)] bg-white/95 backdrop-blur shadow-xl overflow-hidden flex flex-col">
            {renderTeamDiscussion()}
          </Card>
        </div>
      </div>

      {/* Game win modal - add styling to match */}
      {game.gameState?.includes("win") && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center backdrop-blur-sm">
          <Card className="w-96 bg-white/95 shadow-xl">
            <CardContent className="p-6 text-center">
              <h2 className="text-2xl font-bold mb-4 bg-gradient-to-r from-blue-600 to-red-600 text-transparent bg-clip-text">
                {game.gameState === "red_win" ? "Red Team Wins!" : "Blue Team Wins!"}
              </h2>
              <Button
                className="w-full bg-gradient-to-r from-blue-600 to-red-600 hover:from-blue-700 hover:to-red-700"
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