import { useGame } from '../hooks/useGame';
import { TeamDiscussion } from '../components/TeamDiscussion';
import { useEffect } from 'react';
import { GameDiscussion } from '../components/GameDiscussion';

export function GameView({ gameId }: { gameId: number }) {
  console.log('🎯 GAMEVIEW COMPONENT MOUNTED:', { gameId });

  const { game } = useGame(gameId);

  // Debug: Log every render
  useEffect(() => {
    console.log('🎯 GameView rendered:', {
      hasGame: !!game,
      gameId: game?.id,
      discussionCount: game?.teamDiscussion?.length,
      currentTurn: game?.currentTurn,
      fullGameState: game,
      messages: game?.teamDiscussion
    });
  }, [game]);

  // Log every game update
  useEffect(() => {
    if (game) {
      console.log('🎮 Game updated:', {
        id: game.id,
        hasDiscussion: !!game.teamDiscussion,
        messageCount: game.teamDiscussion?.length,
        messages: game.teamDiscussion?.map(m => ({
          player: m.player,
          message: m.message.substring(0, 50) + '...'
        }))
      });
    }
  }, [game]);

  console.log('🎯 GameView RENDER:', {
    hasGame: !!game,
    discussionCount: game?.teamDiscussion?.length,
    discussions: game?.teamDiscussion
  });

  return (
    <div>
      {console.log('🎯 GAMEVIEW JSX:', {
        isRendering: true,
        hasGame: !!game,
        discussionCount: game?.teamDiscussion?.length
      })}
      <GameDiscussion gameId={gameId} />
      {/* Other game components */}
    </div>
  );
} 