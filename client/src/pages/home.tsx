import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { createInitialGame } from "@/lib/game";
import type { AIModel } from "@shared/schema";
import { useState } from "react";

export default function Home() {
  const [_, navigate] = useLocation();
  const [redAIModel, setRedAIModel] = useState<AIModel>("gpt-4o");
  const [blueAIModel, setBlueAIModel] = useState<AIModel>("claude-3-5-sonnet-20241022");

  const startGame = async (redAI: boolean, blueAI: boolean) => {
    const gameData = createInitialGame(redAI, blueAI, redAIModel, blueAIModel);
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
        <CardContent className="space-y-6">
          {/* AI Model Selection */}
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Red Team AI Model</label>
              <Select value={redAIModel} onValueChange={(value) => setRedAIModel(value as AIModel)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select AI Model" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gpt-4o">GPT-4 Omega</SelectItem>
                  <SelectItem value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</SelectItem>
                  <SelectItem value="grok-2-1212">Grok 2</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Blue Team AI Model</label>
              <Select value={blueAIModel} onValueChange={(value) => setBlueAIModel(value as AIModel)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select AI Model" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gpt-4o">GPT-4 Omega</SelectItem>
                  <SelectItem value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</SelectItem>
                  <SelectItem value="grok-2-1212">Grok 2</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

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