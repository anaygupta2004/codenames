import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { createInitialGame } from "@/lib/game";
import type { AIModel, PlayerType } from "@shared/schema";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { 
  SiGooglegemini, 
  SiOpenai, 
  SiMeta, 
  SiAnthropic,
  SiX 
} from 'react-icons/si';

type TeamConfig = {
  spymaster: PlayerType;
  operatives: PlayerType[];
};

const AIOptions = [
  { 
    value: "human", 
    label: "Human Player",
    icon: "👤"
  },
  { 
    value: "gpt-4o", 
    label: "GPT-4 Omega",
    icon: <SiOpenai className="text-blue-500" />,
    description: "OpenAI's most advanced model"
  },
  { 
    value: "claude-3-5-sonnet-20241022", 
    label: "Claude 3.5 Sonnet",
    icon: <SiAnthropic className="text-gray-700" />,
    description: "Anthropic's latest model"
  },
  { 
    value: "grok-2-1212", 
    label: "Grok 2",
    icon: <SiX className="text-black" />,
    description: "xAI's newest model"
  },
  {
    value: "llama-7b",
    label: "LLama 7B",
    icon: <SiMeta className="text-[#0668E1]" />,
    description: "Meta's open source model"
  },
  {
    value: "gemini-pro",
    label: "Gemini Pro",
    icon: <SiGooglegemini className="text-[#4285f4]" />,
    description: "Google's most capable model"
  }
];

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

  const renderPlayerSelect = (
    team: "red" | "blue",
    role: "spymaster" | "operative",
    index?: number,
    value?: PlayerType,
    onChange?: (value: PlayerType) => void
  ) => {
    const currentTeam = team === "red" ? redTeam : blueTeam;
    const actualValue = role === "spymaster" ? currentTeam.spymaster : value;

    return (
      <div className="space-y-2">
        <label className="text-sm font-medium capitalize">
          {role} {index !== undefined && index + 1}
        </label>
        <Select
          value={actualValue}
          onValueChange={(val) => onChange?.(val as PlayerType)}
        >
          <SelectTrigger className="w-full bg-white">
            <SelectValue placeholder={`Select ${role}`}>
              <div className="flex items-center space-x-2">
                {actualValue && AIOptions.find(opt => opt.value === actualValue)?.icon}
                <span>{AIOptions.find(opt => opt.value === actualValue)?.label}</span>
              </div>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {AIOptions.map(option => (
              <SelectItem 
                key={option.value} 
                value={option.value}
                className="flex items-center space-x-2 p-3 cursor-pointer hover:bg-gray-50"
              >
                <div className="flex items-center space-x-3">
                  <span className="text-xl">{typeof option.icon === 'string' ? option.icon : option.icon}</span>
                  <div>
                    <div className="font-medium">{option.label}</div>
                    <div className="text-xs text-gray-500">{option.description}</div>
                  </div>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-neutral-50 to-neutral-100 flex items-center justify-center p-4">
      <Card className="w-full max-w-3xl shadow-lg">
        <CardHeader className="space-y-1 text-center">
          <CardTitle className="text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-red-600">
            Codenames AI
          </CardTitle>
          <p className="text-gray-500">Choose your AI teammates and start playing!</p>
        </CardHeader>
        <CardContent className="space-y-8">
          {/* Red Team Configuration */}
          <div className="space-y-4">
            <div className="flex items-center space-x-2">
              <div className="h-1 w-1 rounded-full bg-red-500" />
              <h2 className="text-xl font-semibold text-red-600">Red Team</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-4 bg-red-50/50 rounded-lg">
              {renderPlayerSelect("red", "spymaster", undefined, undefined, 
                (value) => setRedTeam(prev => ({ ...prev, spymaster: value })))}
              {redTeam.operatives.map((operative, index) => (
                <div key={index}>
                  {renderPlayerSelect("red", "operative", index, operative,
                    (value) => setRedTeam(prev => ({
                      ...prev,
                      operatives: prev.operatives.map((op, i) => i === index ? value : op)
                    })))}
                </div>
              ))}
            </div>
          </div>

          {/* Blue Team Configuration */}
          <div className="space-y-4">
            <div className="flex items-center space-x-2">
              <div className="h-1 w-1 rounded-full bg-blue-500" />
              <h2 className="text-xl font-semibold text-blue-600">Blue Team</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-4 bg-blue-50/50 rounded-lg">
              {renderPlayerSelect("blue", "spymaster", undefined, undefined,
                (value) => setBlueTeam(prev => ({ ...prev, spymaster: value })))}
              {blueTeam.operatives.map((operative, index) => (
                <div key={index}>
                  {renderPlayerSelect("blue", "operative", index, operative,
                    (value) => setBlueTeam(prev => ({
                      ...prev,
                      operatives: prev.operatives.map((op, i) => i === index ? value : op)
                    })))}
                </div>
              ))}
            </div>
          </div>

          <Button
            className="w-full bg-gradient-to-r from-blue-600 to-red-600 hover:from-blue-700 hover:to-red-700 text-white font-bold py-6 text-lg shadow-lg transform transition hover:scale-[1.02]"
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