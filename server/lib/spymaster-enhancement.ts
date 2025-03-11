// Spymaster enhancement module for continuous reasoning
import { backgroundSpymasterThinking, debouncedBackgroundThinking } from './ai-service';
import { GameState } from '@shared/schema';
import { storage } from '../storage';

/**
 * A module that manages continuous spymaster thinking in the background
 * to improve clue quality when it's the spymaster's turn
 */

// Keep track of active background thinking tasks
const activeThinkingSessions = new Map<number, NodeJS.Timeout>();

/**
 * Starts background thinking for the spymaster of the specified team
 * @param gameId Game ID
 * @param teamColor Team color (red or blue)
 * @param skipCurrent If true, skips thinking for the current turn
 */
export async function startSpymasterBackgroundThinking(
  gameId: number, 
  teamColor: 'red' | 'blue',
  skipCurrent: boolean = false
): Promise<void> {
  try {
    // Stop any existing thinking session for this game
    stopSpymasterBackgroundThinking(gameId);

    const game = await storage.getGame(gameId);
    if (!game) {
      console.log(`Cannot start spymaster thinking - game ${gameId} not found`);
      return;
    }

    // Set up which team we're thinking for
    const isRedTeam = teamColor === 'red';
    const spymasterModel = isRedTeam ? game.redSpymaster : game.blueSpymaster;
    
    if (!spymasterModel) {
      console.log(`No spymaster model configured for ${teamColor} team`);
      return;
    }

    // Set up game state for thinking
    const teamWords = isRedTeam ? game.redTeam : game.blueTeam;
    const opposingWords = isRedTeam ? game.blueTeam : game.redTeam;
    const revealedCards = game.revealedCards || [];
    const unrevealed = teamWords.filter(word => !revealedCards.includes(word));

    // Don't bother if all words are revealed already
    if (unrevealed.length === 0) {
      console.log(`All ${teamColor} words revealed, skipping background thinking`);
      return;
    }

    // Immediately trigger a background thinking session
    if (!skipCurrent) {
      await debouncedBackgroundThinking(
        gameId,
        spymasterModel,
        game.words,
        teamWords,
        opposingWords,
        game.assassin,
        game.gameHistory || [],
        game.gameState,
        game.redScore,
        game.blueScore,
        revealedCards,
        teamColor
      );
    }

    // Set up recurring background thinking
    const thinkingInterval = setInterval(async () => {
      try {
        // Fetch updated game state every time to ensure we have latest info
        const updatedGame = await storage.getGame(gameId);
        if (!updatedGame) {
          clearInterval(thinkingInterval);
          activeThinkingSessions.delete(gameId);
          return;
        }

        // Skip if it's already this team's turn (we'll use the regular clue function)
        const currentTurn = updatedGame.currentTurn;
        const isTeamTurn = (teamColor === 'red' && currentTurn === 'red_turn') || 
                          (teamColor === 'blue' && currentTurn === 'blue_turn');
        
        if (isTeamTurn) {
          console.log(`Skipping background thinking for ${teamColor} - it's already their turn`);
          return;
        }

        // Get latest game state for better thinking
        const updatedTeamWords = isRedTeam ? updatedGame.redTeam : updatedGame.blueTeam;
        const updatedOpposingWords = isRedTeam ? updatedGame.blueTeam : updatedGame.redTeam;
        const updatedRevealedCards = updatedGame.revealedCards || [];
        const updatedUnrevealed = updatedTeamWords.filter(word => !updatedRevealedCards.includes(word));

        // Don't bother if all words are revealed now
        if (updatedUnrevealed.length === 0) {
          console.log(`All ${teamColor} words revealed, stopping background thinking`);
          clearInterval(thinkingInterval);
          activeThinkingSessions.delete(gameId);
          return;
        }

        // Trigger background thinking
        await debouncedBackgroundThinking(
          gameId,
          spymasterModel,
          updatedGame.words,
          updatedTeamWords,
          updatedOpposingWords,
          updatedGame.assassin,
          updatedGame.gameHistory || [],
          updatedGame.gameState,
          updatedGame.redScore,
          updatedGame.blueScore,
          updatedRevealedCards,
          teamColor
        );
      } catch (error) {
        console.error(`Error in background thinking interval for game ${gameId}:`, error);
        // Keep the interval going despite errors
      }
    }, 30000); // Think every 30 seconds

    // Store the interval for cleanup
    activeThinkingSessions.set(gameId, thinkingInterval);
    console.log(`🧠 Started background thinking for ${teamColor} spymaster in game ${gameId}`);

  } catch (error) {
    console.error(`Failed to start background thinking:`, error);
  }
}

/**
 * Stops any active background thinking for the specified game
 * @param gameId Game ID
 */
export function stopSpymasterBackgroundThinking(gameId: number): void {
  const existingInterval = activeThinkingSessions.get(gameId);
  if (existingInterval) {
    clearInterval(existingInterval);
    activeThinkingSessions.delete(gameId);
    console.log(`🛑 Stopped background thinking for game ${gameId}`);
  }
}

/**
 * Restarts spymaster thinking for both teams in a game
 * @param gameId Game ID
 */
export async function restartAllSpymasterThinking(gameId: number): Promise<void> {
  // Stop any existing thinking
  stopSpymasterBackgroundThinking(gameId);
  
  // Start thinking for both teams
  await startSpymasterBackgroundThinking(gameId, 'red');
  await startSpymasterBackgroundThinking(gameId, 'blue');
}
