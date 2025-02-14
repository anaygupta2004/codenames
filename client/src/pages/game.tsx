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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/games/${id}`] });
    },
    onError: (error) => {
      toast({
        title: "Error",
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
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  if (isLoading || !game) {
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>;
  }

  const getCardColor = (word: string) => {
    if (game.redTeam.includes(word)) return "bg-red-500";
    if (game.blueTeam.includes(word)) return "bg-blue-500";
    if (game.assassin === word) return "bg-gray-800";
    return "bg-neutral-200";
  };

  const currentTeam = game.currentTurn === "red_turn" ? "Red" : "Blue";
  const isAITurn = (game.currentTurn === "red_turn" && game.redSpymaster) || 
                   (game.currentTurn === "blue_turn" && game.blueSpymaster);

  return (
    <div className="min-h-screen bg-neutral-50 p-4">
      {/* Game Status Header */}
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold mb-2">Codenames AI</h1>
        <div className="flex justify-center items-center gap-4">
          <div className="text-red-500 font-bold">Red Score: {game.redScore}</div>
          <div className={`px-4 py-2 rounded ${game.currentTurn === "red_turn" ? "bg-red-100" : "bg-blue-100"}`}>
            Current Turn: {currentTeam} Team
          </div>
          <div className="text-blue-500 font-bold">Blue Score: {game.blueScore}</div>
        </div>
        {isAITurn && (
          <div className="mt-4">
            <Button
              className="bg-primary hover:bg-primary/90"
              size="lg"
              onClick={() => getAIClue.mutate()}
              disabled={getAIClue.isPending}
            >
              {getAIClue.isPending ? "AI is thinking..." : "Get AI Clue"}
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Game Board */}
        <div className="lg:col-span-4 grid grid-cols-5 gap-2">
          {game.words.map((word) => (
            <Card
              key={word}
              className={`${
                game.revealedCards.includes(word)
                  ? getCardColor(word)
                  : "bg-white hover:bg-gray-50"
              } cursor-pointer transition-colors`}
              onClick={() => !game.revealedCards.includes(word) && makeGuess.mutate(word)}
            >
              <CardContent className="p-4 text-center">
                <span className={game.revealedCards.includes(word) ? "text-white" : ""}>
                  {word}
                </span>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* AI Status Panel */}
        <div className="lg:col-span-1">
          <Card>
            <CardContent className="p-4">
              <h2 className="text-xl font-bold mb-4">AI Status</h2>
              {getAIClue.data && (
                <div className="p-4 bg-primary/5 rounded-lg">
                  <p className="font-semibold">AI Clue:</p>
                  <p className="text-lg">{getAIClue.data.word} ({getAIClue.data.number})</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}