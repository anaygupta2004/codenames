import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { createInitialGame } from "@/lib/game";

export default function Home() {
  const [_, navigate] = useLocation();

  const startGame = async (redAI: boolean, blueAI: boolean) => {
    const gameData = createInitialGame(redAI, blueAI);
    const res = await apiRequest("POST", "/api/games", gameData);
    const game = await res.json();
    navigate(`/game/${game.id}`);
  };

  return (
    <div className="min-h-screen bg-neutral-50 flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-3xl font-bold text-center text-primary">
            Codenames AI
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            className="w-full bg-blue-500 hover:bg-blue-600"
            onClick={() => startGame(false, true)}
          >
            Play as Red Team vs AI
          </Button>
          <Button
            className="w-full bg-red-500 hover:bg-red-600"
            onClick={() => startGame(true, false)}
          >
            Play as Blue Team vs AI
          </Button>
          <Button
            className="w-full"
            variant="outline"
            onClick={() => startGame(true, true)}
          >
            Watch AI vs AI
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}