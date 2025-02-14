import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { type Game, type CardType, type TeamDiscussionEntry } from "@shared/schema";
import { useParams } from "wouter";
import { useEffect, useRef, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertCircle, CheckCircle2, XCircle, Clock, Timer } from "lucide-react";
import { storage } from "@/lib/storage";


export default function GamePage() {
  const { id } = useParams();
  const { toast } = useToast();
  const aiTurnInProgress = useRef(false);
  const [isSpymasterView, setIsSpymasterView] = useState(false);
  const [gameLog, setGameLog] = useState<Array<{
    team: string;
    action: string;
    result: "correct" | "wrong" | "assassin";
    word?: string;
  }>>([]);
  const [timer, setTimer] = useState<number>(30);
  const [isDiscussing, setIsDiscussing] = useState(false);
  const timerRef = useRef<NodeJS.Timeout>();
  const [gameTimeLeft, setGameTimeLeft] = useState<number>(1800); // 30 minutes
  const [turnTimeLeft, setTurnTimeLeft] = useState<number>(180); // 3 minutes
  const gameTimerRef = useRef<NodeJS.Timeout>();
  const turnTimerRef = useRef<NodeJS.Timeout>();

  const { data: game, isLoading } = useQuery<Game>({
    queryKey: [`/api/games/${id}`],
  });

  const getAIClue = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/games/${id}/ai/clue`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
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

  const makeGuess = useMutation({
    mutationFn: async (word: string) => {
      if (!game) return;
      const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";
      let result: "correct" | "wrong" | "assassin";

      if (game.redTeam.includes(word)) {
        result = currentTeam === "red" ? "correct" : "wrong";
      } else if (game.blueTeam.includes(word)) {
        result = currentTeam === "blue" ? "correct" : "wrong";
      } else if (game.assassin === word) {
        result = "assassin";
      } else {
        result = "wrong";
      }

      setGameLog(prev => [...prev, {
        team: currentTeam,
        action: `guessed "${word}"`,
        result,
        word
      }]);

      const res = await apiRequest("PATCH", `/api/games/${id}`, {
        revealedCards: [...(game?.revealedCards || []), word],
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/games/${id}`] });
      aiTurnInProgress.current = false;
    },
    onError: (error: Error) => {
      toast({
        title: "Error making guess",
        description: error.message,
        variant: "destructive",
      });
      aiTurnInProgress.current = false;
    },
  });

  const discussMove = useMutation({
    mutationFn: async (params: { model: string, team: "red" | "blue", clue: any }) => {
      const res = await apiRequest("POST", `/api/games/${id}/ai/discuss`, params);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/games/${id}`] });
    }
  });

  const voteOnWord = useMutation({
    mutationFn: async (params: { model: string, team: "red" | "blue", word: string }) => {
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

  const startDiscussion = async () => {
    if (!game) return;

    setIsDiscussing(true);
    setTimer(30);

    const currentTeam = game.currentTurn === "red_turn" ? game.redPlayers : game.bluePlayers;
    const aiPlayers = currentTeam.filter(player => player !== "human");

    for (const aiPlayer of aiPlayers) {
      await discussMove.mutateAsync({
        model: aiPlayer,
        team: game.currentTurn === "red_turn" ? "red" : "blue",
        clue: getAIClue.data
      });
    }

    timerRef.current = setInterval(() => {
      setTimer(prev => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!game || game.gameState?.includes("win") || aiTurnInProgress.current || isDiscussing) return;

    const isRedTurn = game.currentTurn === "red_turn";
    const currentSpymasterIsAI = isRedTurn ? game.redSpymaster : game.blueSpymaster;

    const handleAITurn = async () => {
      if (!currentSpymasterIsAI || aiTurnInProgress.current) return;

      try {
        aiTurnInProgress.current = true;
        const clue = await getAIClue.mutateAsync();
        if (clue && !game.gameState?.includes("win")) {
          setGameLog(prev => [...prev, {
            team: isRedTurn ? "red" : "blue",
            action: `AI gives clue: "${clue.word} (${clue.number})"`,
            result: "correct"
          }]);
          startDiscussion(); //Start discussion before getting AI guess
          await getAIGuess.mutateAsync(clue);
        }
      } catch (error) {
        console.error("Error in AI turn:", error);
        aiTurnInProgress.current = false;
      }
    };

    handleAITurn();
  }, [game?.currentTurn, game?.gameState]);

  useEffect(() => {
    if (!game) return;

    // Start game timer
    gameTimerRef.current = setInterval(() => {
      setGameTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(gameTimerRef.current);
          // End game when time runs out
          storage.updateGame(game.id, { gameState: "time_up" });
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    // Start turn timer
    turnTimerRef.current = setInterval(() => {
      setTurnTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(turnTimerRef.current);
          // Switch turns when time runs out
          const nextTurn = game.currentTurn === "red_turn" ? "blue_turn" : "red_turn";
          storage.updateGame(game.id, { currentTurn: nextTurn });
          return 180; // Reset to 3 minutes
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (gameTimerRef.current) clearInterval(gameTimerRef.current);
      if (turnTimerRef.current) clearInterval(turnTimerRef.current);
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

  const getLogEmoji = (result: "correct" | "wrong" | "assassin") => {
    switch (result) {
      case "correct": return "✅";
      case "wrong": return "❌";
      case "assassin": return "💀";
      default: return "";
    }
  };

  const renderAIDiscussion = () => {
    if (!game) return null;

    const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";
    const discussions = game.teamDiscussion || [];
    const recentDiscussion = (discussions as TeamDiscussionEntry[])
      .filter(entry => entry.team === currentTeam)
      .sort((a, b) => b.timestamp - a.timestamp);

    return (
      <Card className="mt-4">
        <CardContent className="p-4">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-bold text-lg">AI Team Discussion</h3>
            {isDiscussing && (
              <div className="text-sm font-medium">
                Time remaining: {timer}s
              </div>
            )}
          </div>

          {!isDiscussing && game.currentTurn && !game.gameState?.includes("win") && (
            <Button
              onClick={startDiscussion}
              className="w-full mb-4"
            >
              Start Team Discussion
            </Button>
          )}

          <ScrollArea className="h-[200px]">
            <div className="space-y-2">
              {recentDiscussion.map((entry, index) => (
                <div
                  key={index}
                  className={`p-3 rounded-lg ${
                    entry.team === "red" ? "bg-red-50" : "bg-blue-50"
                  }`}
                >
                  <div className="flex justify-between mb-1">
                    <span className="font-medium">{entry.player}</span>
                    <span className="text-sm text-gray-500">
                      Confidence: {Math.round(entry.confidence * 100)}%
                    </span>
                  </div>
                  <p className="text-sm">{entry.message}</p>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="min-h-screen bg-neutral-50 p-4">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold mb-4">Codenames AI</h1>

        {/* Time indicators */}
        <div className="flex justify-center items-center gap-6 mb-4">
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-gray-600" />
            <span className="font-mono">{formatTime(gameTimeLeft)}</span>
          </div>
          <div className="flex items-center gap-2">
            <Timer className="h-5 w-5 text-gray-600" />
            <span className="font-mono">{formatTime(turnTimeLeft)}</span>
          </div>
        </div>

        <div className="flex justify-center items-center gap-6 mb-4">
          <div className="text-red-500 font-bold text-xl">Red: {game.redScore}</div>
          <div className={`px-6 py-2 rounded-full font-semibold ${
            game.currentTurn === "red_turn" ? "bg-red-100 text-red-700" : "bg-blue-100 text-blue-700"
          }`}>
            {currentTeam}'s Turn {isDiscussing && `(Discussing: ${timer}s)`}
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
          {renderAIDiscussion()}
          <Card>
            <CardContent className="p-4">
              <h3 className="font-bold text-lg mb-4">Game Log</h3>
              <ScrollArea className="h-[200px]">
                <div className="space-y-2">
                  {gameLog.map((log, index) => (
                    <div
                      key={index}
                      className={`p-2 rounded text-sm ${
                        log.team === "red" ? "bg-red-50" : "bg-blue-50"
                      }`}
                    >
                      <span className="font-medium capitalize">{log.team}</span>
                       {log.action}
                       {getLogEmoji(log.result)}
                    </div>
                  ))}
                </div>
              </ScrollArea>
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