import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { Game, TeamDiscussionEntry } from '@shared/schema';
import { queryClient } from '@/lib/queryClient';

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
  // Make this less aggressive to avoid filtering out important messages
  const hashMessage = (msg: any): string => {
    if (!msg) return '';
    
    // Extract key fields to identify the message
    const timestamp = msg.timestamp || 0;
    const player = msg.player || '';
    const message = msg.message || msg.content || '';
    
    // Use a more comprehensive hash that includes parts of the message content
    // This will help distinguish between different messages from the same player at similar times
    return `${timestamp}-${player}-${message.slice(0, 10)}`;
  };

const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      console.log('⚠️ WebSocket already connected, skipping connection');
      return wsRef.current;
    }
    
    if (wsRef.current?.readyState === WebSocket.CONNECTING) {
      console.log('⚠️ WebSocket already connecting, skipping connection');
      return wsRef.current;
    }
    
    console.log('🔌 Creating new WebSocket connection...');
    
    // Use secure connection when appropriate
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
    
    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      
      // Handle connection established
      ws.onopen = () => {
        console.log('🌐 WebSocket connected successfully');
        reconnectAttempts.current = 0;
        
        // Wait a tiny bit before sending join to ensure the socket is fully ready
        setTimeout(() => {
          try {
            if (ws.readyState === WebSocket.OPEN) {
              console.log('⬆️ Sending join message for game:', gameId);
              ws.send(JSON.stringify({ 
                type: 'join', 
                gameId,
                clientId: clientId.current
              }));
            } else {
              console.error('❌ Cannot send join message - WebSocket not open');
            }
          } catch (sendError) {
            console.error('❌ Error sending join message:', sendError);
          }
        }, 100);
      };
    
    ws.onclose = (event) => {
      console.log(`🔌 WebSocket disconnected: Code ${event.code}, clean: ${event.wasClean}`);
      
      // Only set to null if this is the current websocket
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      
      // Try to reconnect unless we're cleaning up or have tried too many times
      if (!cleanupRef.current && reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts.current++;
        const timeout = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 10000);
        console.log(`🔄 Attempting to reconnect in ${timeout}ms... (attempt ${reconnectAttempts.current}/${MAX_RECONNECT_ATTEMPTS})`);
        setTimeout(connect, timeout);
      } else if (reconnectAttempts.current >= MAX_RECONNECT_ATTEMPTS) {
        console.error(`❌ Maximum reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached.`);
      }
    };
    
    ws.onerror = (event) => {
      console.error('❌ WebSocket error:', event);
      
      // If we haven't sent the join message yet, try to reconnect immediately
      if (reconnectAttempts.current === 0) {
        console.log('🔄 Immediate reconnect after error');
        // Only null out if this is our current socket
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        // Try to reconnect with delay
        setTimeout(connect, 1000);
      }
    };
    return ws;
    } catch (connectionError) {
      console.error('❌ Error creating WebSocket connection:', connectionError);
      // Try again once after error
      setTimeout(() => {
        console.log('🔄 Retrying connection after error');
        // Only attempt if we haven't already got one
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          connect();
        }
      }, 1000);
      return null;
    }
  }, [gameId, clientId]);

  useEffect(() => {
    if (cleanupRef.current) return;
    if (!gameId) return;

    const ws = connect();
    if (!ws) return;

    ws.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
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
      
      // Handle discussion cleared event
      if (data.type === 'discussion_cleared') {
        console.log(`🧹 Discussion cleared for team ${data.team}`);
        
        // Clear local discussion state for this team
        setGame(prev => {
          if (!prev) return prev;
          
          // Filter out all messages from this team that aren't turn change messages
          const filteredDiscussion = (prev.teamDiscussion || []).filter(msg => 
            msg.team !== data.team || msg.isTurnChange === true
          );
          
          // Reset all voting state
          const filteredConsensusVotes = (prev.consensusVotes || []).filter(v => 
            v.team !== data.team
          );
          
          const filteredMetaVotes = (prev.metaVotes || []).filter(v => 
            v.team !== data.team
          );
          
          return {
            ...prev,
            teamDiscussion: filteredDiscussion,
            consensusVotes: filteredConsensusVotes,
            metaVotes: filteredMetaVotes
          };
        });
        
        // Clear the processed messages cache too
        processedMessages.current = new Set();
        
        // Force refresh game data
        queryClient.invalidateQueries({ 
          queryKey: [`/api/games/${gameId}`],
          refetchType: 'active'
        });
        
        return;
      }

      if (data.type === 'discussion' || data.type === 'guess' || data.type === 'word_votes' || data.type === 'meta_vote' || data.type === 'turn_change') {
        console.log('💬 Received message:', {
          type: data.type,
          team: data.team,
          player: data.player,
          content: data.content?.substring(0, 30) + '...',
          hasTimeInfo: !!data.timeInfo,
          hasVoting: data.isVoting,
          voteType: data.voteType,
          messageCount: game?.teamDiscussion?.length
        });
        
        // CRITICAL: Force an immediate refresh of the game data
        queryClient.invalidateQueries({ 
          queryKey: [`/api/games/${gameId}`],
          refetchType: 'active' 
        });

        setGame(prev => {
          console.log('💫 UPDATING GAME STATE:', {
            previousState: prev ? { id: prev.id, messageCount: prev.teamDiscussion?.length } : null,
            newMessage: { type: data.type, player: data.player }
          });

          if (!prev) {
            console.log('❌ No previous game state');
            return prev;
          }

          // Start with the base game state
          const newState = { ...prev };
          
          // Handle different message types
          if (data.type === 'discussion') {
            // Create a new discussion entry - ensure all fields are properly mapped
            const newEntry: TeamDiscussionEntry = {
              team: data.team,
              player: data.player,
              message: data.content || data.message || '', // Support both content and message fields
              confidences: data.confidences || [data.confidence || 0.5],
              suggestedWords: data.suggestedWords || [],
              timestamp: data.timestamp,
              isVoting: Boolean(data.isVoting),
              voteType: data.voteType || '',
              timeInfo: data.timeInfo
            };
            
            // Always ensure we have proper arrays for suggestedWords and confidences
            if (!newEntry.suggestedWords) {
              newEntry.suggestedWords = [];
            }
            
            // If old-style suggestedWord is present, convert to array format
            if (data.suggestedWord && (!newEntry.suggestedWords || newEntry.suggestedWords.length === 0)) {
              newEntry.suggestedWords = [data.suggestedWord];
            }
            
            // Ensure confidences array matches suggestedWords length
            if (newEntry.suggestedWords.length > 0 && 
                (!newEntry.confidences || newEntry.confidences.length < newEntry.suggestedWords.length)) {
              
              // Create a confidences array that matches the length of suggestedWords
              const baseConfidence = data.confidence || 0.7;
              newEntry.confidences = newEntry.suggestedWords.map((_, idx) => {
                // Scale confidence down for each subsequent word
                return Math.max(0.3, baseConfidence * (1 - idx * 0.15));
              });
            }
            
            // For debugging - log the actual message content
            console.log(`📨 Message from ${data.player}: ${newEntry.message}`);
            console.log(`Has suggested words: ${Boolean(newEntry.suggestedWords && newEntry.suggestedWords.length > 0)}`);
            if (newEntry.suggestedWords.length > 0) {
              console.log(`Words: ${newEntry.suggestedWords.join(', ')}`);
              console.log(`Confidences: ${newEntry.confidences?.join(', ')}`);
            }
            
            // IMPORTANT: Do not filter out messages, always add them
            // We'll just use a better hash function to detect true duplicates
            const messageHash = hashMessage(newEntry);
            let isDuplicate = messageHash && processedMessages.current.has(messageHash);
            
            if (isDuplicate) {
              console.log(`⚠️ Possible duplicate detected with hash ${messageHash}`);
              // If hash matches, but it has voting information, keep it anyway
              if (newEntry.isVoting || newEntry.suggestedWords.length > 0) {
                console.log(`🔄 Message has voting/suggestion data, adding anyway`);
                isDuplicate = false;
              }
            }
            
            // Only track actual duplicates by hash
            if (!isDuplicate && messageHash) {
              processedMessages.current.add(messageHash);
            }
            
            // CRITICAL: Do not drop messages with suggestions or voting
            // Better to have duplicates than miss important messages
            newState.teamDiscussion = [
              ...(prev.teamDiscussion || []),
              newEntry
            ];
            
            console.log(`✅ Added message from ${newEntry.player}, isVoting: ${newEntry.isVoting}, suggestedWords: ${newEntry.suggestedWords.length}, type: ${newEntry.voteType}`);
            
            // IMPORTANT: Force a cache update to ensure React Query pulls the new message
            // This ensures messages appear in both TeamDiscussion and useGame state
            queryClient.invalidateQueries({ 
              queryKey: [`/api/games/${gameId}`],
              refetchType: 'active' 
            });
          } 
          else if (data.type === 'guess') {
            // Add guess to discussion
            newState.teamDiscussion = [
              ...(prev.teamDiscussion || []),
              {
                team: data.team,
                player: 'Game' as const,
                message: `Guessed: ${data.content || data.word}`,
                confidences: [1],
                suggestedWords: [data.content || data.word],
                timestamp: data.timestamp
              }
            ];
            
            // Update revealed cards
            const guessedWord = data.content || data.word;
            newState.revealedCards = [...(prev.revealedCards || [])];
            
            // Only add if not already revealed
            if (guessedWord && !newState.revealedCards.includes(guessedWord)) {
              newState.revealedCards.push(guessedWord);
            }
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
          else if (data.type === 'turn_change') {
            console.log('🔄 Processing turn change:', data);
            
            // CRITICAL: Reset the game's turn state immediately
            newState.currentTurn = data.to === 'red' ? 'red_turn' : 'blue_turn';
            
            // Reset the turn timer by updating current start time
            // THIS IS CRITICAL for proper timer function
            newState.currentTurnStartTime = new Date();
            
            // Get detailed reason with word information if available
            let reasonText = data.reason || '';
            if (data.word) {
              reasonText += ` (word: ${data.word})`;
            }
            if (data.highPriority || data.forced) {
              reasonText += ' [forced]';
            }
            
            // Create a richer message with reason if available
            const message = `Turn ended${reasonText ? ` (${reasonText})` : ''}. ${data.to.toUpperCase()} team's turn now.`;
            
            // Add a prominent notification message to the discussion
            newState.teamDiscussion = [
              ...(prev.teamDiscussion || []),
              {
                team: data.from,
                player: 'Game' as const,
                message: message,
                confidences: [1],
                suggestedWords: [],
                timestamp: data.timestamp || Date.now(),
                // Special flag for turn change messages
                isTurnChange: true,
                // Mark as high priority for forced turn changes
                highPriority: data.highPriority || data.forced || data.reason === 'time_expired'
              }
            ];
            
            // Also add message to other team's discussion for ALL turn changes
            // This ensures both teams are aware of turn changes
            newState.teamDiscussion.push({
              team: data.to,
              player: 'Game' as const,
              message: `${data.from.toUpperCase()} team's turn ended${reasonText ? ` (${reasonText})` : ''}. It's your turn now!`,
              confidences: [1],
              suggestedWords: [],
              timestamp: (data.timestamp || Date.now()) + 1,
              // Special flags for turn change messages
              isTurnChange: true, 
              isTurnStart: true,
              highPriority: data.highPriority || data.forced || data.reason === 'time_expired'
            });
            
            // CRITICAL: For timer expiration and other forced turn changes, we need to ensure
            // the client state is fully reset for the new turn
            if (data.reason === 'time_expired' || data.highPriority || data.forced) {
              console.log('🚨 FORCED TURN CHANGE - Resetting client state');
              
              // Clear any active votes or discussions as the turn has forcibly ended
              newState.metaVotes = newState.metaVotes?.filter(v => v.team !== data.from) || [];
              newState.consensusVotes = newState.consensusVotes?.filter(v => v.team !== data.from) || [];
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