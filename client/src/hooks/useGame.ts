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

  // Track processed message hashes to avoid duplicates
  const processedMessages = useRef(new Set<string>());

  // Create a hash function for message uniqueness
  const hashMessage = (msg: any): string => {
    if (!msg) return '';
    
    // Extract key fields to identify the message
    const timestamp = msg.timestamp || 0;
    const player = msg.player || '';
    const messageText = msg.message?.substring(0, 50) || '';
    const suggestedWords = Array.isArray(msg.suggestedWords) ? msg.suggestedWords.join(',') : '';
    
    // Create a composite hash
    return `${timestamp}-${player}-${messageText}-${suggestedWords}`;
  };

const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    
    // Use secure connection when appropriate
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws`);
    wsRef.current = ws;
    
    ws.onopen = () => {
      console.log('🌐 WebSocket connected');
      reconnectAttempts.current = 0;
      ws.send(JSON.stringify({ 
        type: 'join', 
        gameId,
        clientId: clientId.current
      }));
      console.log('⬆️ Sent join message for game:', gameId);
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
      try {
        const data = JSON.parse(event.data);
        console.log('📥 WEBSOCKET MESSAGE RECEIVED:', {
          type: data.type,
          team: data.team,
          parsedData: data,
          currentGameState: game ? { id: game.id, discussionCount: game.teamDiscussion?.length } : null
        });
      } catch (error) {
        console.error('Error parsing WebSocket message:', error, event.data);
        return;
      }
      
      const data = JSON.parse(event.data);
      
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

      if (data.type === 'discussion' || data.type === 'guess' || data.type === 'word_votes' || data.type === 'meta_vote') {
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

          // Start with the base game state
          const newState = { ...prev };
          
          // Handle different message types
          if (data.type === 'discussion') {
            // Create a new discussion entry
            const newEntry: TeamDiscussionEntry = {
              team: data.team,
              player: data.player,
              message: data.message,
              confidences: data.confidences || [data.confidence || 0],
              suggestedWords: data.suggestedWords || [],
              timestamp: data.timestamp,
              isVoting: data.isVoting,
              voteType: data.voteType,
              timeInfo: data.timeInfo
            };
            
            // If old-style suggestedWord is present, convert to array format
            if (data.suggestedWord && (!newEntry.suggestedWords || newEntry.suggestedWords.length === 0)) {
              newEntry.suggestedWords = [data.suggestedWord];
            }
            
            // Check for duplicates using our hash function
            const messageHash = hashMessage(newEntry);
            
            if (messageHash && !processedMessages.current.has(messageHash)) {
              // Mark as processed
              processedMessages.current.add(messageHash);
              
              // Add to discussion array
              newState.teamDiscussion = [
                ...(prev.teamDiscussion || []),
                newEntry
              ];
              
              console.log(`✍️ Added new message from ${newEntry.player} with hash ${messageHash}`);
            } else if (messageHash) {
              console.log(`🔄 Skipped duplicate message with hash ${messageHash}`);
              // Just return the existing state for duplicates
              return prev;
            } else {
              // Still add the message if hash couldn't be computed
              newState.teamDiscussion = [
                ...(prev.teamDiscussion || []),
                newEntry
              ];
            }
          } 
          else if (data.type === 'guess') {
            // Add guess to discussion
            newState.teamDiscussion = [
              ...(prev.teamDiscussion || []),
              {
                team: data.team,
                player: 'Game' as const,
                message: `Guessed: ${data.content}`,
                confidences: [1],
                suggestedWords: [data.content],
                timestamp: data.timestamp
              }
            ];
            
            // Update revealed cards
            newState.revealedCards = [...(prev.revealedCards || []), data.content];
          }
          else if (data.type === 'word_votes') {
            console.log('💠 Processing word votes:', data);
            // Make sure the data is properly structured
            if (data.words && Array.isArray(data.words)) {
              // Store word votes in consensusVotes
              const newVotes = data.words.flatMap(wordData => {
                if (!wordData || !wordData.voters || !Array.isArray(wordData.voters)) {
                  console.warn('Invalid word vote data:', wordData);
                  return [];
                }
                return wordData.voters.map(voter => ({
                  team: data.team,
                  player: voter.player,
                  word: wordData.word,
                  approved: true,
                  confidence: voter.confidence || 0.5,
                  timestamp: data.timestamp || Date.now()
                }));
              });
              
              // Append new votes to existing ones with deduplication
              const existingVotes = prev.consensusVotes || [];
              const voteMap = new Map();
              
              // Index existing votes
              existingVotes.forEach(vote => {
                voteMap.set(`${vote.player}-${vote.word}`, vote);
              });
              
              // Add or update with new votes
              newVotes.forEach(vote => {
                voteMap.set(`${vote.player}-${vote.word}`, vote);
              });
              
              newState.consensusVotes = Array.from(voteMap.values());
              console.log('Updated consensus votes:', newState.consensusVotes);
            }
          }
          else if (data.type === 'meta_vote') {
            console.log('💠 Processing meta vote:', data);
            if (data.voters && Array.isArray(data.voters)) {
              // Store meta votes with deduplication
              const existingVotes = prev.metaVotes || [];
              const voteMap = new Map();
              
              // Index existing votes
              existingVotes.forEach(vote => {
                voteMap.set(`${vote.player}-${vote.action}`, vote);
              });
              
              // Add new votes
              data.voters.forEach(voter => {
                const newVote = {
                  team: data.team,
                  player: voter.player,
                  action: data.action,
                  timestamp: data.timestamp || Date.now(),
                  confidence: voter.confidence || 0.5
                };
                voteMap.set(`${voter.player}-${data.action}`, newVote);
              });
              
              newState.metaVotes = Array.from(voteMap.values());
              console.log('Updated meta votes:', newState.metaVotes);
            }
          }

          console.log('📝 New state after update:', {
            type: data.type,
            messageCount: newState.teamDiscussion?.length,
            voteCount: newState.consensusVotes?.length,
            metaVoteCount: newState.metaVotes?.length
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
          
          // Merge discussions to avoid duplicates using our hash function
          const messageMap = new Map();
          
          allDiscussions.forEach(msg => {
            const key = hashMessage(msg);
            if (key) {
              messageMap.set(key, msg);
            }
          });
          
          const uniqueDiscussions = Array.from(messageMap.values())
            .sort((a, b) => a.timestamp - b.timestamp);

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
      // Use our universal hash function
      const key = hashMessage(msg);
      if (key && !unique.has(key)) {
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