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
};

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
  const [timer, setTimer] = useState<number>(60);
  const [isDiscussing, setIsDiscussing] = useState(false);
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.8);
  const [votingInProgress, setVotingInProgress] = useState(false);
  const timerRef = useRef<NodeJS.Timeout>();
  const [lastClue, setLastClue] = useState<{ word: string; number: number } | null>(null);

  const { data: game, isLoading } = useQuery<Game>({
    queryKey: [`/api/games/${id}`],
  });

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
    },
  });

  const discussMove = useMutation({
    mutationFn: async (params: { model: string; team: "red" | "blue"; clue: any }) => {
      const res = await apiRequest("POST", `/api/games/${id}/ai/discuss`, params);
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      // If confidence is very high, trigger immediate voting
      if (data.confidence > confidenceThreshold) {
        setVotingInProgress(true);
        await voteOnWord.mutateAsync({
          model: params.model,
          team: params.team,
          word: data.suggestedWord
        });
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/games/${id}`] });
    }
  });

  const voteOnWord = useMutation({
    mutationFn: async (params: { model: string; team: "red" | "blue"; word: string }) => {
      const res = await apiRequest("POST", `/api/games/${id}/ai/vote`, params);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [`/api/games/${id}`] });
      if (data.allApproved) {
        makeGuess.mutate(data.vote.word);
        setIsDiscussing(false);
        if (timerRef.current) {
          clearInterval(timerRef.current);
        }
      }
    }
  });

  const makeGuess = useMutation({
    mutationFn: async (word: string) => {
      if (!game) return;
      const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";
      let result: "correct" | "wrong" | "assassin" = "wrong";

      if (game.redTeam.includes(word)) {
        result = currentTeam === "red" ? "correct" : "wrong";
      } else if (game.blueTeam.includes(word)) {
        result = currentTeam === "blue" ? "correct" : "wrong";
      } else if (game.assassin === word) {
        result = "assassin";
      }

      const currentPlayer = game.currentTurn === "red_turn" ?
        game.redSpymaster : game.blueSpymaster;

      setGameLog(prev => [...prev, {
        team: currentTeam,
        action: `guessed "${word}"`,
        result,
        word,
        player: currentPlayer as string
      }]);

      const res = await apiRequest("PATCH", `/api/games/${id}`, {
        revealedCards: [...(game?.revealedCards || []), word],
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return { data, result };
    },
    onSuccess: ({ data, result }) => {
      queryClient.invalidateQueries({ queryKey: [`/api/games/${id}`] });
      aiTurnInProgress.current = false;
      setLastClue(null);
      setIsDiscussing(false);

      if (result === "wrong" || result === "assassin") {
        setTimer(60);
      }
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

  const handleAITurn = async () => {
    try {
      aiTurnInProgress.current = true;
      const clue = await getAIClue.mutateAsync();

      if (clue && !game?.gameState?.includes("win")) {
        const isRedTeam = game.currentTurn === "red_turn";
        const currentTeam = isRedTeam ? "red" : "blue";
        const currentSpymaster = isRedTeam ? game.redSpymaster : game.blueSpymaster;
        const modelInfo = AI_MODEL_INFO[currentSpymaster as keyof typeof AI_MODEL_INFO];

        setGameLog(prev => [...prev, {
          team: currentTeam,
          action: `gives clue: "${clue.word} (${clue.number})"`,
          result: "correct",
          player: currentSpymaster as string
        }]);

        // Start team discussion with shorter timer
        setIsDiscussing(true);
        setTimer(30); // Reduced from 60 to 30 seconds

        // Get current team's AI players
        const currentTeamPlayers = isRedTeam ? game.redPlayers : game.bluePlayers;
        const aiPlayers = currentTeamPlayers.filter(
          player => typeof player === 'string' && player !== 'human' && player !== currentSpymaster
        ) as string[];

        // Run AI discussions in parallel instead of sequentially
        await Promise.all(aiPlayers.map(async (aiPlayer) => {
          await discussMove.mutateAsync({
            model: aiPlayer,
            team: currentTeam,
            clue
          });
        }));

        // Trigger immediate voting after discussions
        handleTimeoutVoting();
      }
    } catch (error) {
      console.error("Error in AI turn:", error);
      aiTurnInProgress.current = false;
      // Switch turns if there's an error
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

  useEffect(() => {
    if (isDiscussing) {
      const interval = setInterval(() => {
        setTimer((prev) => {
          if (prev <= 1) {
            clearInterval(interval);
            // Force voting when time runs out
            handleTimeoutVoting();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      return () => clearInterval(interval);
    }
  }, [isDiscussing]);

  const handleTimeoutVoting = async () => {
    if (!game) return;

    const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";
    const teamDiscussion = (game.teamDiscussion || []) as TeamDiscussionEntry[];
    const currentTeamDiscussions = teamDiscussion
      .filter(entry => entry.team === currentTeam)
      .filter(entry => entry.suggestedWord); // Only consider entries with suggestions

    if (currentTeamDiscussions.length === 0) {
      await switchTurns();
      return;
    }

    // Find the word with highest confidence across all discussions
    const mostConfidentSuggestion = currentTeamDiscussions.reduce((prev, current) => {
      return (current.confidence > prev.confidence) ? current : prev;
    });

    if (mostConfidentSuggestion && mostConfidentSuggestion.confidence > 0.6) {
      try {
        setVotingInProgress(true);
        const currentPlayers = game.currentTurn === "red_turn" ? game.redPlayers : game.bluePlayers;
        const aiPlayers = currentPlayers.filter(player =>
          typeof player === 'string' && player !== 'human'
        ) as string[];

        // Collect votes from all AI players
        for (const aiPlayer of aiPlayers) {
          await voteOnWord.mutateAsync({
            model: aiPlayer,
            team: currentTeam,
            word: mostConfidentSuggestion.suggestedWord
          });
        }

        // Make the guess with the most confident suggestion
        await makeGuess.mutateAsync(mostConfidentSuggestion.suggestedWord);

      } catch (error) {
        console.error("Error in timeout voting:", error);
        await switchTurns();
      }
    } else {
      await switchTurns();
    }

    setVotingInProgress(false);
    setIsDiscussing(false);
  };

  const switchTurns = async () => {
    try {
      setIsDiscussing(false);
      const nextTurn = game?.currentTurn === "red_turn" ? "blue_turn" : "red_turn";
      await apiRequest("PATCH", `/api/games/${id}`, {
        currentTurn: nextTurn
      });
      await queryClient.invalidateQueries({ queryKey: [`/api/games/${id}`] });
      setTimer(30); // Reset timer for next turn
      setLastClue(null);
      aiTurnInProgress.current = false;
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
                <Timer className="w-4 h-4" />
                <span className={`text-sm font-medium ${
                  timer <= 10 ? 'text-red-500' : ''
                }`}>
                  {timer}s
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
                const modelInfo = AI_MODEL_INFO[entry.player as keyof typeof AI_MODEL_INFO] || {
                  name: entry.player,
                  Icon: Bot
                };
                const { Icon } = modelInfo;

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
                    {entry.suggestedWord && (
                      <p className="text-sm mt-2 font-medium">
                        Suggests: {entry.suggestedWord}
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

  const getModelInfo = (model: string) => {
    return AI_MODEL_INFO[model as keyof typeof AI_MODEL_INFO] || {
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
            const modelInfo = log.player ? AI_MODEL_INFO[log.player as keyof typeof AI_MODEL_INFO] : null;
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
            {currentTeam}'s Turn {isDiscussing && `(Discussion: ${timer}s)`}
          </div>
          <div className="text-blue-500 font-bold text-xl">Blue: {game.blueScore}</div>
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