import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
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
  });

  const makeGuess = useMutation({
    mutationFn: async (word: string) => {
      const res = await apiRequest("PATCH", `/api/games/${id}`, {
        revealedCards: [...(game?.revealedCards || []), word],
      });
      return res.json();
    },
  });

  if (isLoading || !game) {
    return <div>Loading...</div>;
  }

  const getCardColor = (word: string) => {
    if (game.redTeam.includes(word)) return "bg-red-500";
    if (game.blueTeam.includes(word)) return "bg-blue-500";
    if (game.assassin === word) return "bg-gray-800";
    return "bg-neutral-200";
  };

  return (
    <div className="min-h-screen bg-neutral-50 p-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-4">
          <div className="grid grid-cols-5 gap-2">
            {game.words.map((word) => (
              <Card
                key={word}
                className={`${
                  game.revealedCards.includes(word)
                    ? getCardColor(word)
                    : "bg-white"
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
          <div className="flex justify-between">
            <div className="text-red-500">Red Score: {game.redScore}</div>
            <div className="text-blue-500">Blue Score: {game.blueScore}</div>
          </div>
        </div>
        <div className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <h2 className="text-xl font-bold mb-4">Game Status</h2>
              <p>Current Turn: {game.currentTurn === "red_turn" ? "Red Team" : "Blue Team"}</p>
              {getAIClue.data && (
                <div className="mt-4">
                  <p>AI Clue: {getAIClue.data.word} ({getAIClue.data.number})</p>
                </div>
              )}
              <Button
                className="mt-4"
                onClick={() => getAIClue.mutate()}
                disabled={getAIClue.isPending}
              >
                Get AI Clue
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
