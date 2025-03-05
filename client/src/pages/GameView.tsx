import { useGame } from '../hooks/useGame';
import { TeamDiscussion } from '../components/TeamDiscussion';
import { GameBoard } from '../components/GameBoard';
import { useEffect, useState, useCallback } from 'react';

export function GameView({ gameId }: { gameId: number }) {
  console.log('🎯 GAMEVIEW COMPONENT MOUNTED:', { gameId });
  
  const [showRedDiscussion, setShowRedDiscussion] = useState(true);
  const [showBlueDiscussion, setShowBlueDiscussion] = useState(true);
  const [userTeam, setUserTeam] = useState<'red' | 'blue' | null>(null);
  
  const { game } = useGame(gameId);

  // Handle team selection
  const selectTeam = (team: 'red' | 'blue') => {
    setUserTeam(team);
    // Show only the selected team's discussion initially
    if (team === 'red') {
      setShowRedDiscussion(true);
      setShowBlueDiscussion(false);
    } else {
      setShowRedDiscussion(false);
      setShowBlueDiscussion(true);
    }
  };

  // Handle voting for a word
  const handleVote = useCallback(async (word: string, team: string) => {
    if (!gameId) return;
    
    try {
      console.log(`Submitting vote for word: "${word}" for team ${team}`);
      
      const response = await fetch(`/api/games/${gameId}/ai/vote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'human',
          team,
          word
        })
      });
      
      if (!response.ok) {
        console.error('Failed to submit vote:', await response.text());
        return;
      }
      
      const result = await response.json();
      console.log('Vote submitted successfully:', result);
      
    } catch (error) {
      console.error('Error submitting vote:', error);
    }
  }, [gameId]);

  // Handle guessing a word
  const handleGuess = useCallback(async (word: string) => {
    if (!gameId || !game || !userTeam) return;
    
    try {
      console.log(`Making guess for word: "${word}" as team ${userTeam}`);
      
      // Add the word to revealed cards
      const updatedRevealedCards = [...(game.revealedCards || []), word];
      
      // Update the game with the new revealed card
      const response = await fetch(`/api/games/${gameId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          revealedCards: updatedRevealedCards
        })
      });
      
      if (!response.ok) {
        console.error('Failed to submit guess:', await response.text());
        return;
      }
      
      const result = await response.json();
      console.log('Guess submitted successfully:', result);
      
    } catch (error) {
      console.error('Error submitting guess:', error);
    }
  }, [gameId, game, userTeam]);

  // Debug: Log every render
  useEffect(() => {
    console.log('🎯 GameView rendered:', {
      hasGame: !!game,
      gameId: game?.id,
      discussionCount: game?.teamDiscussion?.length,
      currentTurn: game?.currentTurn,
      fullGameState: game
    });
  }, [game]);

  if (!game) {
    return <div>Loading game...</div>;
  }
  
  // Filter messages by team
  const redMessages = game?.teamDiscussion?.filter(msg => msg.team === 'red') || [];
  const blueMessages = game?.teamDiscussion?.filter(msg => msg.team === 'blue') || [];

  return (
    <div>
      <h1>Game #{gameId}</h1>
      
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div>
          <h2 style={{ color: 'red' }}>Red Team: {game.redScore}</h2>
        </div>
        <div>
          <h2 style={{ color: 'blue' }}>Blue Team: {game.blueScore}</h2>
        </div>
      </div>
      
      <div style={{ 
        padding: '10px', 
        marginBottom: '20px', 
        backgroundColor: '#f5f5f5',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center' 
      }}>
        <h3>Turn: {game.currentTurn}</h3>
        
        {/* Team selection buttons */}
        {!userTeam && (
          <div style={{ display: 'flex', gap: '10px' }}>
            <button 
              onClick={() => selectTeam('red')}
              style={{
                padding: '8px 16px',
                backgroundColor: '#ffdddd',
                border: '2px solid #cc0000',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 'bold',
                color: '#cc0000'
              }}
            >
              Join Red Team
            </button>
            
            <button 
              onClick={() => selectTeam('blue')}
              style={{
                padding: '8px 16px',
                backgroundColor: '#ddddff',
                border: '2px solid #0066cc',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 'bold',
                color: '#0066cc'
              }}
            >
              Join Blue Team
            </button>
          </div>
        )}
        
        {userTeam && (
          <div style={{
            padding: '5px 12px',
            backgroundColor: userTeam === 'red' ? '#ffdddd' : '#ddddff',
            border: `2px solid ${userTeam === 'red' ? '#cc0000' : '#0066cc'}`,
            borderRadius: '4px',
            color: userTeam === 'red' ? '#cc0000' : '#0066cc',
            fontWeight: 'bold'
          }}>
            You are on the {userTeam.toUpperCase()} team
          </div>
        )}
      </div>
      
      {/* Game board */}
      <div style={{ marginBottom: '30px' }}>
        <GameBoard 
          game={game} 
          team={userTeam || undefined} 
          onGuess={handleGuess}
          onVote={handleVote}
        />
      </div>
      
      {/* Discussion toggles */}
      <div style={{ marginBottom: '20px', display: 'flex', gap: '10px' }}>
        <button 
          onClick={() => setShowRedDiscussion(!showRedDiscussion)}
          style={{
            padding: '8px 12px',
            backgroundColor: showRedDiscussion ? '#ffdddd' : '#f8f8f8',
            border: `2px solid ${showRedDiscussion ? '#cc0000' : '#ddd'}`,
            borderRadius: '4px',
            cursor: 'pointer'
          }}
        >
          {showRedDiscussion ? 'Hide' : 'Show'} Red Discussion ({redMessages.length})
        </button>
        
        <button 
          onClick={() => setShowBlueDiscussion(!showBlueDiscussion)}
          style={{
            padding: '8px 12px',
            backgroundColor: showBlueDiscussion ? '#ddddff' : '#f8f8f8',
            border: `2px solid ${showBlueDiscussion ? '#0066cc' : '#ddd'}`,
            borderRadius: '4px',
            cursor: 'pointer'
          }}
        >
          {showBlueDiscussion ? 'Hide' : 'Show'} Blue Discussion ({blueMessages.length})
        </button>
      </div>
      
      <div style={{ display: 'flex', gap: '20px' }}>
        {/* Red Team discussion */}
        {showRedDiscussion && (
          <div style={{ flex: 1 }}>
            <h2 style={{ color: '#cc0000', marginBottom: '10px' }}>Red Team Discussion</h2>
            <TeamDiscussion 
              messages={redMessages}
              gameId={gameId}
              team={userTeam === 'red' ? 'red' : undefined}
              onVote={userTeam === 'red' ? handleVote : undefined}
            />
          </div>
        )}
        
        {/* Blue Team discussion */}
        {showBlueDiscussion && (
          <div style={{ flex: 1 }}>
            <h2 style={{ color: '#0066cc', marginBottom: '10px' }}>Blue Team Discussion</h2>
            <TeamDiscussion 
              messages={blueMessages}
              gameId={gameId}
              team={userTeam === 'blue' ? 'blue' : undefined}
              onVote={userTeam === 'blue' ? handleVote : undefined}
            />
          </div>
        )}
      </div>
      
      {/* Game history */}
      <div style={{ marginTop: '30px' }}>
        <h2 style={{ color: '#333', marginBottom: '10px' }}>Game History</h2>
        <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid #ddd', padding: '10px' }}>
          {game.gameHistory?.length > 0 ? (
            game.gameHistory.map((entry, index) => (
              <div 
                key={index}
                style={{
                  padding: '8px',
                  margin: '4px 0',
                  backgroundColor: entry.turn === 'red' ? '#ffebee' : '#e3f2fd',
                  borderRadius: '4px',
                  borderLeft: `4px solid ${entry.turn === 'red' ? '#cc0000' : '#0066cc'}`
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 'bold' }}>
                    {entry.turn === 'red' ? '🔴' : '🔵'} {entry.type.toUpperCase()}
                  </span>
                  <span style={{ fontSize: '0.8em', color: '#666' }}>
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <div>{entry.content}</div>
                {entry.reasoning && (
                  <div style={{ 
                    marginTop: '4px', 
                    fontSize: '0.9em', 
                    fontStyle: 'italic', 
                    color: '#666',
                    borderTop: '1px dotted #ccc',
                    paddingTop: '4px'
                  }}>
                    {entry.reasoning}
                  </div>
                )}
              </div>
            ))
          ) : (
            <div>No game history yet</div>
          )}
        </div>
      </div>
    </div>
  );
} 