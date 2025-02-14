import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { createInitialGame } from "@/lib/game";
import type { AIModel, PlayerType } from "@shared/schema";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

type TeamConfig = {
  spymaster: PlayerType;
  operatives: PlayerType[];
};

export default function Home() {
  const [_, navigate] = useLocation();
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [redTeam, setRedTeam] = useState<TeamConfig>({
    spymaster: "gpt-4o",
    operatives: ["human", "claude-3-5-sonnet-20241022"]
  });
  const [blueTeam, setBlueTeam] = useState<TeamConfig>({
    spymaster: "claude-3-5-sonnet-20241022",
    operatives: ["human", "grok-2-1212"]
  });

  const startGame = async () => {
    try {
      setIsLoading(true);
      const redTeamConfig = [redTeam.spymaster, ...redTeam.operatives];
      const blueTeamConfig = [blueTeam.spymaster, ...blueTeam.operatives];

      const gameData = createInitialGame(redTeamConfig, blueTeamConfig);
      const res = await apiRequest("POST", "/api/games", gameData);
      const game = await res.json();
      navigate(`/game/${game.id}`);
    } catch (error) {
      toast({
        title: "Failed to start game",
        description: error instanceof Error ? error.message : "Please try again",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const AIOptions = [
    { value: "human", label: "Human Player" },
    { value: "gpt-4o", label: "GPT-4 Omega" },
    { value: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet" },
    { value: "grok-2-1212", label: "Grok 2" }
  ];

  return (
    <div className="min-h-screen bg-neutral-50 flex items-center justify-center p-4">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="text-3xl font-bold text-center text-primary">
            Codenames AI
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-8">
          {/* Red Team Configuration */}
          <div className="space-y-4">
            <h2 className="text-xl font-semibold text-red-600">Red Team</h2>
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Spymaster</label>
                <Select 
                  value={redTeam.spymaster} 
                  onValueChange={(value) => setRedTeam(prev => ({
                    ...prev,
                    spymaster: value as PlayerType
                  }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select Spymaster" />
                  </SelectTrigger>
                  <SelectContent>
                    {AIOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {redTeam.operatives.map((operative, index) => (
                <div key={index} className="space-y-2">
                  <label className="text-sm font-medium">Operative {index + 1}</label>
                  <Select
                    value={operative}
                    onValueChange={(value) => setRedTeam(prev => ({
                      ...prev,
                      operatives: prev.operatives.map((op, i) => 
                        i === index ? value as PlayerType : op
                      )
                    }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select Operative" />
                    </SelectTrigger>
                    <SelectContent>
                      {AIOptions.map(option => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </div>

          {/* Blue Team Configuration */}
          <div className="space-y-4">
            <h2 className="text-xl font-semibold text-blue-600">Blue Team</h2>
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Spymaster</label>
                <Select
                  value={blueTeam.spymaster}
                  onValueChange={(value) => setBlueTeam(prev => ({
                    ...prev,
                    spymaster: value as PlayerType
                  }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select Spymaster" />
                  </SelectTrigger>
                  <SelectContent>
                    {AIOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {blueTeam.operatives.map((operative, index) => (
                <div key={index} className="space-y-2">
                  <label className="text-sm font-medium">Operative {index + 1}</label>
                  <Select
                    value={operative}
                    onValueChange={(value) => setBlueTeam(prev => ({
                      ...prev,
                      operatives: prev.operatives.map((op, i) => 
                        i === index ? value as PlayerType : op
                      )
                    }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select Operative" />
                    </SelectTrigger>
                    <SelectContent>
                      {AIOptions.map(option => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </div>

          <Button
            className="w-full bg-green-600 hover:bg-green-700 text-white"
            size="lg"
            onClick={startGame}
            disabled={isLoading}
          >
            {isLoading ? "Starting Game..." : "Start Game"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}