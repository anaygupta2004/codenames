import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { Game, TeamDiscussionEntry } from '@shared/schema';

export function useGame(gameId?: number) {
  console.log('🎮 useGame INITIALIZED:', { gameId });
  const [game, setGame] = useState<Game | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const cleanupRef = useRef(false);
  const reconnectAttempts = useRef(0);
  const MAX_RECONNECT_ATTEMPTS = 3;
  const clientId = useRef(localStorage.getItem('clientId') || (() => {
    const newId = Math.random().toString(36).substring(7);
    localStorage.setItem('clientId', newId);
    return newId;
  })());

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    
    const ws = new WebSocket(`ws://${window.location.host}/ws`);
    wsRef.current = ws;
    
    ws.onopen = () => {
      console.log('WebSocket connected');
      reconnectAttempts.current = 0;
      ws.send(JSON.stringify({ 
        type: 'join', 
        gameId,
        clientId: clientId.current
      }));
    };
    
    ws.onclose = () => {
      console.log('WebSocket disconnected');
      wsRef.current = null;
      
      // Try to reconnect unless we're cleaning up or have tried too many times
      if (!cleanupRef.current && reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts.current++;
        const timeout = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 10000);
        console.log(`Attempting to reconnect in ${timeout}ms...`);
        setTimeout(connect, timeout);
      }
    };
    
    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
    
    return ws;
  }, [gameId]);

  useEffect(() => {
    if (cleanupRef.current) return;
    if (!gameId) return;

    const ws = connect();
    if (!ws) return;

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log('📥 WEBSOCKET MESSAGE RECEIVED:', {
        rawData: event.data,
        parsedData: data,
        currentGameState: game
      });
      
      if (data.type === 'error') {
        console.error('Server error:', data.message);
        // Only mark the connection as dead if the error indicates the game is not active
        if (data.message === 'This game is no longer active.') {
          cleanupRef.current = true;
          if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
          }
        }
        // Otherwise, leave reconnection logic to try again
        return;
      }

      // Handle server-initiated cleanup
      if (data.type === 'cleanup') {
        console.log('Received cleanup signal from server');
        cleanupRef.current = true;  // Set cleanup mode
        localStorage.clear();
        sessionStorage.clear();
        if (wsRef.current) {
          wsRef.current.close();
          wsRef.current = null;
        }
        window.location.reload();
        return;
      }

      if (data.type === 'reset') {
        // Clear local storage and close connection
        localStorage.removeItem('clientId');
        if (wsRef.current) {
          wsRef.current.close();
          wsRef.current = null;
        }
        // Generate new client ID for future
        clientId.current = Math.random().toString(36).substring(7);
        localStorage.setItem('clientId', clientId.current);
        return;
      }

      if (data.type === 'discussion' || data.type === 'guess') {
        console.log('💬 Received message:', {
          type: data.type,
          team: data.team,
          player: data.player,
          messageCount: game?.teamDiscussion?.length
        });

        setGame(prev => {
          console.log('💫 UPDATING GAME STATE:', {
            previousState: prev,
            newMessage: data
          });

          if (!prev) {
            console.log('❌ No previous game state');
            return prev;
          }

          console.log('🔍 Game state before update:', {
            id: prev.id,
            currentTurn: prev.currentTurn,
            discussionCount: prev.teamDiscussion?.length,
            fullState: prev
          });

          const newState = {
            ...prev,
            teamDiscussion: [
              ...(prev.teamDiscussion || []),
              ...(data.type === 'discussion' ? [{
                team: data.team,
                player: data.player,
                message: data.message,
                confidence: data.confidence || 0,
                suggestedWord: data.suggestedWord,
                timestamp: data.timestamp
              }] : []),
              ...(data.type === 'guess' ? [{
                team: data.team,
                player: 'Game' as const,
                message: `Guessed: ${data.content}`,
                confidence: 1,
                suggestedWord: data.content,
                timestamp: data.timestamp
              }] : [])
            ] as TeamDiscussionEntry[],
            revealedCards: data.type === 'guess'
              ? [...(prev.revealedCards || []), data.content]
              : prev.revealedCards,
          };

          console.log('📝 New discussion entry:', {
            type: data.type,
            messageCount: newState.teamDiscussion.length,
            lastMessage: newState.teamDiscussion[newState.teamDiscussion.length - 1],
            allMessages: newState.teamDiscussion
          });

          console.log('✨ NEW GAME STATE:', {
            oldDiscussionCount: prev.teamDiscussion?.length || 0,
            newDiscussionCount: newState.teamDiscussion.length,
            fullNewState: newState
          });

          return newState;
        });
      }
    };

    return () => {
      cleanupRef.current = true;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [gameId, connect]);

  // Initial game fetch
  useEffect(() => {
    if (!gameId) return;
    
    async function fetchInitialGame() {
      try {
        console.log('🎯 Fetching initial game state');
        const res = await fetch(`/api/games/${gameId}`);
        if (!res.ok) throw new Error('Failed to fetch game');
        const initialGame = await res.json();
        console.log('✨ Initial game state:', {
          hasDiscussion: !!initialGame.teamDiscussion,
          discussionCount: initialGame.teamDiscussion?.length
        });
        setGame(initialGame);
      } catch (error) {
        console.error('Initial fetch error:', error);
      }
    }
    
    fetchInitialGame();
  }, [gameId]);

  // Polling for updates
  useEffect(() => {
    if (!gameId) return;
    
    console.log('🔄 Starting game polling');
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/games/${gameId}`);
        if (!res.ok) throw new Error('Failed to fetch game');
        const latestGame = await res.json();
        
        console.log('📥 Poll received:', {
          hasDiscussion: !!latestGame.teamDiscussion,
          messageCount: latestGame.teamDiscussion?.length,
          messages: latestGame.teamDiscussion
        });
        
        setGame(prev => {
          console.log('🔄 Merging game states:', {
            prevCount: prev?.teamDiscussion?.length || 0,
            newCount: latestGame.teamDiscussion?.length || 0
          });

          if (!prev) return latestGame;
          
          // Merge discussions to avoid duplicates
          const allDiscussions = [
            ...(prev.teamDiscussion || []),
            ...(latestGame.teamDiscussion || [])
          ];
          
          const uniqueDiscussions = Array.from(
            new Map(allDiscussions.map(msg => 
              [`${msg.timestamp}-${msg.player}`, msg]
            )).values()
          ).sort((a, b) => a.timestamp - b.timestamp);

          console.log('✨ Merged discussions:', {
            totalMessages: allDiscussions.length,
            uniqueMessages: uniqueDiscussions.length
          });

          return {
            ...latestGame,
            teamDiscussion: uniqueDiscussions
          };
        });
      } catch (error) {
        console.error('Polling error:', error);
      }
    }, 2000); // Poll every 2 seconds
    
    return () => clearInterval(pollInterval);
  }, [gameId]);

  // Add a helper function to merge discussion arrays without duplicates.
  function mergeDiscussion(
    latest: any[] = [], 
    prev: any[] = []
  ): any[] {
    const all = [...prev, ...latest];
    const unique = new Map();
    all.forEach(msg => {
      // Create a composite key. Adjust fields as needed.
      const key = `${msg.timestamp}-${msg.player}-${msg.message}`;
      if (!unique.has(key)) {
        unique.set(key, msg);
      }
    });
    // Sort by timestamp (ascending)
    return Array.from(unique.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  // Debug: Log every game state change
  useEffect(() => {
    console.log('🎲 Game state changed:', {
      hasGame: !!game,
      gameId: game?.id,
      discussionCount: game?.teamDiscussion?.length,
      messages: game?.teamDiscussion
    });
  }, [game]);

  return { game, clientId, wsRef };
} 