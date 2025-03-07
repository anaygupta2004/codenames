import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useState, useEffect } from "react";

interface GameBoardProps {
  game: any;
  team?: string;
  onGuess?: (word: string) => void;
  onVote?: (word: string, team: string) => void;
}

export function GameBoard({ game, team, onGuess, onVote, ...props }: GameBoardProps) {
  const [spymasterView, setSpymasterView] = useState(false);
  const [wordInfo, setWordInfo] = useState<Record<string, any>>({});
  const [selectedWord, setSelectedWord] = useState<string | null>(null);
  const [wordVotes, setWordVotes] = useState<Record<string, {votes: number, confidence: number}>>({});

  // Function to handle clicking on a word in the game board
  const handleWordClick = (word: string) => {
    if (game.revealedCards?.includes(word)) return;
    
    // Set the selected word
    setSelectedWord(word);
    
    // Check if there's a consensus vote for this word
    const consensusReached = checkConsensusForWord(word);
    
    if (consensusReached && onGuess) {
      // If there's consensus, make the guess
      onGuess(word);
      // Clear selection
      setSelectedWord(null);
    } else if (onVote && team) {
      // If no consensus yet, vote for the word
      onVote(word, team);
    }
  };
  
  // Function to check if there's consensus for a word
  const checkConsensusForWord = (word: string) => {
    if (!game.consensusVotes) return false;
    
    // Get all votes for this word
    const votesForWord = game.consensusVotes.filter((v: any) => v.word === word);
    
    // Check if there are enough votes for a consensus (over 50% of team)
    const currentTeamPlayers = (team === "red" ? game.redPlayers : game.bluePlayers) || [];
    const aiPlayers = currentTeamPlayers.filter((p: string) => p !== "human" && p !== (team === "red" ? game.redSpymaster : game.blueSpymaster));
    
    // Check if over 50% of AI players voted for this word
    return votesForWord.length > (aiPlayers.length / 2);
  };
  
  // Update wordVotes based on consensus votes
  useEffect(() => {
    if (game?.consensusVotes) {
      const voteCounts: Record<string, {votes: number, confidence: number}> = {};
      
      // Count votes per word
      game.consensusVotes.forEach((vote: any) => {
        if (!voteCounts[vote.word]) {
          voteCounts[vote.word] = { votes: 0, confidence: 0 };
        }
        
        if (vote.approved) {
          voteCounts[vote.word].votes += 1;
          voteCounts[vote.word].confidence += vote.confidence;
        }
      });
      
      // Calculate average confidence
      Object.keys(voteCounts).forEach(word => {
        if (voteCounts[word].votes > 0) {
          voteCounts[word].confidence = voteCounts[word].confidence / voteCounts[word].votes;
        }
      });
      
      setWordVotes(voteCounts);
    }
  }, [game?.consensusVotes]);

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
    const modelNames: Record<string, string> = {
      'gpt-4o': 'GPT-4o',
      'claude-3-5-sonnet-20241022': 'Claude',
      'grok-2-1212': 'Grok',
      'gemini-1.5-pro': 'Gemini'
    };
    
    return modelNames[player] || player;
  };

  // Enhanced vote indicator for a word - shows if there's voting progress and triggers auto-guess
  const getVoteIndicator = (word: string) => {
    if (!wordVotes[word]) return null;
    
    const voteCount = wordVotes[word].votes;
    const avgConfidence = wordVotes[word].confidence;
    
    if (voteCount === 0) return null;
    
    // Get total team members for percentage calculation
    const currentTeamPlayers = (team === "red" ? game.redPlayers : game.bluePlayers) || [];
    const totalTeamMembers = currentTeamPlayers.length;
    const aiPlayers = currentTeamPlayers.filter((p: string) => p !== "human" && p !== (team === "red" ? game.redSpymaster : game.blueSpymaster));
    
    // Include human in the count if the user is on a team
    const totalVoters = Math.max(1, aiPlayers.length + (team ? 1 : 0));
    const votePercentage = Math.round((voteCount / totalVoters) * 100);
    
    // Enhanced auto-guess threshold: lower to 30% and also consider confidence
    const isHighConfidence = avgConfidence >= 0.75;
    const meetsTriggerThreshold = votePercentage >= 30 || (isHighConfidence && voteCount >= 2);
    
    // Color based on vote percentage and confidence
    const bgColor = meetsTriggerThreshold ? "bg-green-100 text-green-800 border border-green-300" : 
                   votePercentage > 20 ? "bg-yellow-100 text-yellow-800 border border-yellow-300" : 
                   "bg-gray-100 text-gray-800 border border-gray-300";
    
    // Auto-trigger guess after a short delay when threshold is reached
    useEffect(() => {
      // Only auto-guess for the team whose turn it is
      const isCurrentTeamTurn = 
        (team === "red" && game.currentTurn === "red_turn") || 
        (team === "blue" && game.currentTurn === "blue_turn");
      
      if (meetsTriggerThreshold && isCurrentTeamTurn && onGuess) {
        const autoGuessTimeout = setTimeout(() => {
          console.log(`🎯 Auto-triggering guess for ${word} with ${voteCount} votes (${votePercentage}%) and confidence ${avgConfidence}`);
          onGuess(word);
        }, 2000); // 2 second delay before auto-guessing
        
        return () => clearTimeout(autoGuessTimeout);
      }
    }, [meetsTriggerThreshold, voteCount, votePercentage]);
    
    // Enhanced indicator that pulses more prominently
    return (
      <div className={`absolute top-0 right-0 px-2 py-1 text-xs font-bold 
        ${meetsTriggerThreshold ? "rounded-md -mt-2 -mr-2 shadow-md animate-pulse bg-green-500 text-white" : "rounded-bl-md " + bgColor}`}>
        {voteCount} votes ({votePercentage}%)
        {meetsTriggerThreshold && (
          <span className="block text-[10px] mt-0.5">
            {isHighConfidence ? "✓ High confidence!" : "✓ Enough votes!"}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="grid grid-cols-12 gap-4 h-screen p-4">
      {/* Left sidebar - Game Log */}
      <div className="col-span-2 bg-muted rounded-lg p-4">
        <h2 className="font-semibold mb-4">Game Log</h2>
        <ScrollArea className="h-[calc(100vh-10rem)]">
          {game.gameHistory?.map((entry: any, i: number) => (
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
          {game.words.map((word: string, index: number) => (
            <Card
              key={index}
              className={cn(
                "p-4 text-center cursor-pointer transition-colors relative",
                selectedWord === word ? "ring-2 ring-primary" : "",
                spymasterView ? getWordStyle(word, wordInfo[word]) : 
                  (game.revealedCards?.includes(word) ? "bg-muted" : "hover:bg-muted")
              )}
              onClick={() => handleWordClick(word)}
            >
              {word}
              {!game.revealedCards?.includes(word) && getVoteIndicator(word)}
              
              {/* No manual voting UI - automatic voting only */}
            </Card>
          ))}
        </div>
        
        {/* Toggle for spymaster view */}
        <div className="mt-4 flex justify-end">
          <button 
            className={`px-4 py-2 rounded ${spymasterView ? 'bg-red-500 text-white' : 'bg-gray-200'}`}
            onClick={() => setSpymasterView(!spymasterView)}
          >
            {spymasterView ? 'Hide Spymaster View' : 'Show Spymaster View'}
          </button>
        </div>
      </div>

      {/* Right sidebar - Team Chat */}
      <div className="col-span-3 bg-muted rounded-lg p-4">
        <h2 className="font-semibold mb-4">Team Discussion</h2>
        <ScrollArea className="h-[calc(100vh-10rem)]">
          {game.teamDiscussion?.map((msg: any, i: number) => (
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
              {/* Display multiple word suggestions if available */}
              {msg.suggestedWords && msg.suggestedWords.length > 0 ? (
                <div className="mt-1 text-xs font-medium">
                  <span className="text-primary font-bold">Suggestions:</span>
                  <ul className="list-disc pl-5 mt-1 space-y-1">
                    {msg.suggestedWords.map((word: string, idx: number) => {
                      // Use proper confidence for each word
                      const wordConfidence = msg.confidences && msg.confidences[idx] !== undefined 
                        ? msg.confidences[idx] 
                        : (msg.confidence ? msg.confidence * (1 - idx * 0.15) : 0.5);
                        
                      return (
                        <li key={idx} className={`${idx === 0 ? "text-primary font-semibold" : "text-primary/70"} flex justify-between`}>
                          <span>
                            {word} ({(wordConfidence * 100).toFixed(0)}% confident)
                          </span>
                          
                          {/* Add vote button for team members */}
                          {msg.team === team && !game.revealedCards?.includes(word) && (
                            <button 
                              className="text-xs bg-blue-100 hover:bg-blue-200 text-blue-800 py-0 px-2 rounded ml-2"
                              onClick={() => onVote && team && onVote(word, team)}
                            >
                              Vote
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : msg.suggestedWord ? (
                <div className="mt-1 text-xs font-medium text-primary">
                  Suggests: {msg.suggestedWord} 
                  {msg.confidence && ` (${(msg.confidence * 100).toFixed(0)}% confident)`}
                </div>
              ) : null}
              
              {/* Display voting information if available */}
              {game.consensusVotes && game.consensusVotes.some((v: any) => v.player === msg.player) && (
                <div className="mt-1 text-xs italic text-secondary-foreground/70">
                  {game.consensusVotes
                    .filter((v: any) => v.player === msg.player)
                    .map((vote: any, idx: number) => (
                      <div key={idx}>
                        {vote.approved ? 
                          `✓ Voted for "${vote.word}" (${(vote.confidence * 100).toFixed(0)}%)` : 
                          `✗ Voted against "${vote.word}" (${(vote.confidence * 100).toFixed(0)}%)`}
                      </div>
                    ))
                  }
                </div>
              )}
            </div>
          ))}
        </ScrollArea>
        
        {/* Chat input - only show for human players */}
        {game.redPlayers?.includes("human") || game.bluePlayers?.includes("human") ? (
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