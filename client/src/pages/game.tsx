import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { type Game } from "@shared/schema";
import { useParams } from "wouter";

export default function GamePage() {
  const { id } = useParams();
  const { toast } = useToast();

  const { data: game, isLoading } = useQuery<Game>({
    queryKey: [`/api/games/${id}`],
  });

  const getAIClue = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/games/${id}/ai/clue`);
      return res.json();
    },
    onError: (error) => {
      toast({
        title: "Error getting AI clue",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const makeGuess = useMutation({
    mutationFn: async (word: string) => {
      const res = await apiRequest("PATCH", `/api/games/${id}`, {
        revealedCards: [...(game?.revealedCards || []), word],
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/games/${id}`] });
    },
    onError: (error) => {
      toast({
        title: "Error making guess",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  if (isLoading || !game) {
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>;
  }

  const getCardColor = (word: string) => {
    if (game.revealedCards.includes(word)) {
      if (game.redTeam.includes(word)) return "bg-red-500";
      if (game.blueTeam.includes(word)) return "bg-blue-500";
      if (game.assassin === word) return "bg-gray-800";
      return "bg-neutral-200";
    }
    return "bg-white hover:bg-gray-50";
  };

  const getTextColor = (word: string) => {
    return game.revealedCards.includes(word) ? "text-white" : "text-gray-900";
  };

  const currentTeam = game.currentTurn === "red_turn" ? "Red" : "Blue";
  const isSpymasterAI = game.currentTurn === "red_turn" ? game.redSpymaster : game.blueSpymaster;

  return (
    <div className="min-h-screen bg-neutral-50 p-4">
      {/* Game Header */}
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold mb-4">Codenames AI</h1>

        {/* Score and Turn Indicator */}
        <div className="flex justify-center items-center gap-6 mb-4">
          <div className="text-red-500 font-bold text-xl">Red: {game.redScore}</div>
          <div className={`px-6 py-2 rounded-full font-semibold ${
            game.currentTurn === "red_turn" ? "bg-red-100 text-red-700" : "bg-blue-100 text-blue-700"
          }`}>
            {currentTeam}'s Turn
          </div>
          <div className="text-blue-500 font-bold text-xl">Blue: {game.blueScore}</div>
        </div>

        {/* AI Controls */}
        {isSpymasterAI && (
          <div className="mt-4">
            <Button
              className="bg-primary hover:bg-primary/90 text-white px-8"
              size="lg"
              onClick={() => getAIClue.mutate()}
              disabled={getAIClue.isPending || game.gameState?.includes("win")}
            >
              {getAIClue.isPending ? "AI is thinking..." : "Get AI Clue"}
            </Button>
          </div>
        )}

        {/* Show AI's clue if available */}
        {getAIClue.data && (
          <div className="mt-4 inline-block px-6 py-3 bg-primary/5 rounded-lg">
            <span className="font-semibold mr-2">AI Clue:</span>
            <span className="text-lg">
              {getAIClue.data.word} ({getAIClue.data.number})
            </span>
          </div>
        )}
      </div>

      {/* Game Board */}
      <div className="max-w-5xl mx-auto grid grid-cols-5 gap-3">
        {game.words.map((word) => (
          <Card
            key={word}
            className={`${getCardColor(word)} cursor-pointer transition-all hover:scale-105`}
            onClick={() => {
              if (!game.revealedCards.includes(word) && !game.gameState?.includes("win")) {
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

      {/* Game End State */}
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