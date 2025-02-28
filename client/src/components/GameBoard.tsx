import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useState, useEffect } from "react";

interface GameBoardProps {
  // ... your existing props
}

export function GameBoard({ game, team, ...props }: GameBoardProps) {
  const [spymasterView, setSpymasterView] = useState(false);
  const [wordInfo, setWordInfo] = useState<Record<string, any>>({});

  useEffect(() => {
    if (spymasterView && game) {
      fetch(`/api/games/${game.id}/spymaster`)
        .then(res => res.json())
        .then(data => {
          const info = data.words.reduce((acc: any, w: any) => {
            acc[w.word] = { team: w.team, revealed: w.revealed };
            return acc;
          }, {});
          setWordInfo(info);
        });
    }
  }, [spymasterView, game?.id]);

  const getWordStyle = (word: string, wordInfo: any) => {
    if (!wordInfo) return "bg-white";
    
    const baseStyle = wordInfo.revealed ? "opacity-50" : "";
    
    switch (wordInfo.team) {
      case 'red':
        return `${baseStyle} bg-red-500 text-white`;
      case 'blue':
        return `${baseStyle} bg-blue-500 text-white`;
      case 'assassin':
        return `${baseStyle} bg-black text-white`;
      default:
        return `${baseStyle} bg-gray-300`;
    }
  };

  const getModelDisplayName = (player: string) => {
    // Implement your logic to get a model's display name based on the player
    // This is a placeholder and should be replaced with the actual implementation
    return player;
  };

  return (
    <div className="grid grid-cols-12 gap-4 h-screen p-4">
      {/* Left sidebar - Game Log */}
      <div className="col-span-2 bg-muted rounded-lg p-4">
        <h2 className="font-semibold mb-4">Game Log</h2>
        <ScrollArea className="h-[calc(100vh-8rem)]">
          {game.gameHistory?.map((entry, i) => (
            <div key={i} className="mb-2">
              <p className="text-sm text-muted-foreground">
                {new Date(entry.timestamp).toLocaleTimeString()}
              </p>
              <p className={cn(
                "text-sm",
                entry.turn === "red" ? "text-red-500" : "text-blue-500"
              )}>
                {entry.content}
              </p>
              <Separator className="my-2" />
            </div>
          ))}
        </ScrollArea>
      </div>

      {/* Main game board */}
      <div className="col-span-7 bg-background rounded-lg p-4">
        <div className="grid grid-cols-5 gap-2">
          {game.words.map((word, index) => (
            <Card
              key={index}
              className={cn(
                "p-4 text-center cursor-pointer transition-colors",
                spymasterView ? getWordStyle(word, wordInfo[word]) : 
                  (game.revealedCards?.includes(word) ? "bg-muted" : "hover:bg-muted")
              )}
            >
              {word}
            </Card>
          ))}
        </div>
      </div>

      {/* Right sidebar - Team Chat */}
      <div className="col-span-3 bg-muted rounded-lg p-4">
        <h2 className="font-semibold mb-4">Team Discussion</h2>
        <ScrollArea className="h-[calc(100vh-12rem)]">
          {game.teamDiscussion?.map((msg, i) => (
            <div key={i} className={cn(
              "mb-4 p-2 rounded",
              msg.team === team ? "bg-primary/10 ml-4" : "bg-muted mr-4"
            )}>
              <div className="flex items-center gap-2 mb-1">
                <span className={cn(
                  "font-medium",
                  msg.team === "red" ? "text-red-500" : "text-blue-500"
                )}>
                  {getModelDisplayName(msg.player)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <p className="text-sm">{msg.message}</p>
              {msg.suggestedWord && (
                <div className="mt-1 text-xs font-medium text-primary">
                  Suggests: {msg.suggestedWord} 
                  {msg.confidence && ` (${(msg.confidence * 100).toFixed(0)}% confident)`}
                </div>
              )}
            </div>
          ))}
        </ScrollArea>
        
        {/* Chat input - only show for human players */}
        {game.redPlayers.includes("human") || game.bluePlayers.includes("human") ? (
          <div className="mt-4">
            <input
              type="text"
              placeholder="Type your message..."
              className="w-full p-2 rounded border"
              // Add your chat input handler here
            />
          </div>
        ) : null}
      </div>
    </div>
  );
} 