import React, { useEffect, useState } from 'react';
import type { TeamDiscussionEntry, ConsensusVote } from '@shared/schema';

// Helper function for proper markdown-style text formatting
const formatMessage = (text: string) => {
  if (!text) return '';
  
  // Process markdown in specific order to avoid nested conflicts
  return text
    // Bold: **text**
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Italic: *text*
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // Underline: __text__
    .replace(/__(.*?)__/g, '<u>$1</u>')
    // Strikethrough: ~~text~~
    .replace(/~~(.*?)~~/g, '<s>$1</s>');
};

// Add keyframe animation for pulse effect
const pulseAnimation = `
@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(0, 0, 0, 0.1);
  }
  70% {
    box-shadow: 0 0 0 6px rgba(0, 0, 0, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(0, 0, 0, 0);
  }
}
`;

// Add style element to head
document.head.insertAdjacentHTML('beforeend', `<style>${pulseAnimation}</style>`);

// Define an extended version of TeamDiscussionEntry with confidence
type ExtendedTeamDiscussionEntry = TeamDiscussionEntry & {
  confidence?: number; // Legacy field - we'll handle both formats
  // Handle both single word and multiple words
  suggestedWord?: string;
  // Support legacy confidence field and new array
  confidences?: number[];
  // Support both content and message fields
  content?: string;
  timeInfo?: {
    turnStartTime: number;
    turnTimeLimit: number;
    remainingTime: number;
  };
  type?: string;
};

interface TeamDiscussionProps {
  messages: ExtendedTeamDiscussionEntry[];
  gameId?: number;
  team?: string;
  onVote?: (word: string, team: string) => void;
}

export function TeamDiscussion({ messages, gameId, team, onVote }: TeamDiscussionProps) {
  // State for voting
  const [wordVotes, setWordVotes] = useState<{
    [word: string]: {
      votes: number;
      voters: { player: string; confidence: number }[];
      percentage: number;
    }
  }>({});
  
  // Add revealed cards state to avoid voting on already guessed words
  const [revealedCards, setRevealedCards] = useState<string[]>([]);

  const [metaVotes, setMetaVotes] = useState<{
    action: 'continue' | 'end_turn' | 'discuss_more';
    votes: number;
    voters: { player: string; confidence: number }[];
    percentage: number;
  }>({
    action: 'continue',
    votes: 0,
    voters: [],
    percentage: 0
  });
  
  // Debug state
  console.log('🗳️ Current vote state:', { wordVotes, metaVotes });

  console.log('💬 TEAMDISCUSSION COMPONENT MOUNTED:', {
    hasMessages: !!messages,
    messageCount: messages?.length
  });

  // Track local state for discussion messages to avoid issues with props
  const [localDiscussion, setLocalDiscussion] = useState<TeamDiscussionEntry[]>([]);
  
  // Debug: Log every time component receives props
  useEffect(() => {
    console.log('💬 TeamDiscussion received props:', {
      hasMessages: !!messages,
      messageCount: messages?.length,
      messages
    });
    
    // Always update our local state with the latest message data
    if (messages && messages.length > 0) {
      // Update local state directly to ensure immediate UI update
      setLocalDiscussion(prev => {
        // Create a merged set without duplicates
        const newMessages = [...prev];
        const existingMsgIds = new Set(prev.map(m => `${m.timestamp}-${m.player}`));
        
        messages.forEach(msg => {
          // Ensure message field is properly populated from either message or content field
          const processedMsg = {
            ...msg,
            // Make sure message field is always populated
            message: msg.message || msg.content || ''
          };
          
          const msgId = `${processedMsg.timestamp}-${processedMsg.player}`;
          if (!existingMsgIds.has(msgId)) {
            newMessages.push(processedMsg);
          }
        });
        
        console.log(`📝 Updated localDiscussion: ${newMessages.length} messages`);
        return newMessages;
      });
    } else if (messages && messages.length === 0) {
      // If we receive an empty messages array, clear our local state too
      console.log('🧹 Received empty messages array - clearing local discussion');
      setLocalDiscussion([]);
    }
  }, [messages]);
  
  // ALWAYS use both props and local state for maximum chance of displaying messages
  console.log('🔍 SHOWING MESSAGES:', {
    propsMessages: messages?.length || 0,
    localMessages: localDiscussion?.length || 0
  });
  
  // Combine both sources of messages to ensure we don't miss any
  // But also deduplicate them using a more comprehensive hash
  const messageMap = new Map();
  
  // Custom hash function to better identify unique messages
  const getMessageHash = (msg: any): string => {
    if (!msg) return '';
    
    // Extract key fields to identify the message
    const timestamp = msg.timestamp || 0;
    const player = msg.player || '';
    const message = msg.message || msg.content || '';
    
    // Include a bit of message content to better distinguish messages
    return `${timestamp}-${player}-${message.slice(0, 10)}`;
  };
  
  // First add all messages from props
  (messages || []).forEach(msg => {
    // Ensure message has the content field (some messages only have content, not message)
    const processedMsg = {
      ...msg,
      message: msg.message || msg.content || '' // Ensure message field is populated
    };
    
    const key = getMessageHash(processedMsg);
    messageMap.set(key, processedMsg);
  });
  
  // Then add local messages
  (localDiscussion || []).forEach(msg => {
    const processedMsg = {
      ...msg,
      message: msg.message || msg.content || '' // Ensure message field is populated
    };
    
    const key = getMessageHash(processedMsg);
    messageMap.set(key, processedMsg);
  });
  
  // Convert back to array and sort by timestamp
  const validMessages = Array.from(messageMap.values())
    .sort((a, b) => a.timestamp - b.timestamp);
  
  // Ensure all messages have required fields - avoid undefined errors
  const normalizedMessages = validMessages.map(msg => ({
    ...msg,
    message: msg.message || msg.content || '',
    confidences: msg.confidences || [msg.confidence || 0.5],
    suggestedWords: msg.suggestedWords || (msg.suggestedWord ? [msg.suggestedWord] : [])
  }));

  // WebSocket for real-time voting
  useEffect(() => {
    // Init state from messages prop and fetch current game state
    const initFromMessages = async () => {
      try {
        // Get current game state to know revealed cards
        const res = await fetch(`/api/games/${gameId}`);
        const game = await res.json();
        
        // Store revealed cards to skip them for voting
        if (game?.revealedCards) {
          setRevealedCards(game.revealedCards);
        }
        
        // Find messages with suggested words and populate wordVotes
        console.log('🔄 Initializing vote state from messages');
        
        // Process any votes already in the messages
        if (messages && Array.isArray(messages)) {
          const newWordVotes = {...wordVotes};
          const wordsWithSuggestions = new Set<string>();
          
          // Collect all suggested words that haven't been revealed yet
          messages.forEach(msg => {
            if (msg.suggestedWords && Array.isArray(msg.suggestedWords)) {
              msg.suggestedWords.forEach(word => {
                // Only add words that haven't been revealed yet
                if (!game?.revealedCards?.includes(word)) {
                  wordsWithSuggestions.add(word);
                }
              });
            }
          });
          
          // Initialize all with empty votes
          Array.from(wordsWithSuggestions).forEach(word => {
            if (!newWordVotes[word]) {
              newWordVotes[word] = {
                votes: 0,
                voters: [],
                percentage: 0
              };
            }
          });
          
          // Only update if we have suggestions
          if (wordsWithSuggestions.size > 0) {
            console.log('📊 Initialized votes for words:', Array.from(wordsWithSuggestions));
            setWordVotes(newWordVotes);
          }
        }
      } catch (error) {
        console.error("Error initializing from messages:", error);
      }
    };
    
    // Run initialization
    initFromMessages();
    
    // Setup WebSocket connection to receive votes
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
      console.log('WebSocket connected for voting');
      if (gameId) {
        // Generate a client ID if not already present
        const clientId = localStorage.getItem('clientId') || (() => {
          const newId = Math.random().toString(36).substring(7);
          localStorage.setItem('clientId', newId);
          return newId;
        })();
        
        // Join the game
        ws.send(JSON.stringify({ 
          type: 'join', 
          gameId,
          clientId
        }));
      }
    };
    
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('🔔 TeamDiscussion WebSocket message received:', data);
        
        // If we receive a guess, update our revealed cards list
        if (data.type === 'guess' && data.word) {
          console.log(`📋 Word guessed: ${data.word}`);
          setRevealedCards(prev => {
            if (!prev.includes(data.word)) {
              return [...prev, data.word];
            }
            return prev;
          });
          
          // Completely remove the guessed word from votes and UI
          setWordVotes(prev => {
            const newVotes = {...prev};
            // Aggressively remove the guessed word from votes
            if (newVotes[data.word]) {
              console.log(`🗑️ Removing voted word "${data.word}" since it was guessed`);
              delete newVotes[data.word];
            }
            
            // Also clean up any other revealed words that might still have votes
            const currentRevealedCards = [...revealedCards, data.word];
            Object.keys(newVotes).forEach(word => {
              if (currentRevealedCards.includes(word)) {
                console.log(`🧹 Cleaning up already revealed word "${word}" from votes`);
                delete newVotes[word];
              }
            });
            
            return newVotes;
          });
          
          // Add a meta decision for this team after a correct guess
          if (data.result === 'correct' && data.team === team) {
            console.log('✅ Correct guess - triggering meta decision');
            
            // Send a meta decision message
            setTimeout(() => {
              fetch(`/api/games/${gameId}/meta/discuss`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  message: "Should we continue guessing or end turn?",
                  team,
                  triggerVoting: true
                })
              }).catch(err => console.error("Error triggering meta vote:", err));
            }, 1000);
          }
        }
        
        // Process word votes
        if (data.type === 'word_votes') {
          console.log('🗳️ Received word votes:', data);
          
          // Create a new object rather than mutating the existing one
          const newWordVotes = {...wordVotes};
          
          if (Array.isArray(data.words)) {
            data.words.forEach((wordData: any) => {
              // Skip votes for already revealed words
              if (wordData?.word && !revealedCards.includes(wordData.word)) {
                newWordVotes[wordData.word] = {
                  votes: wordData.votes || 0,
                  voters: Array.isArray(wordData.voters) ? wordData.voters : [],
                  percentage: wordData.percentage || 0
                };
              }
            });
            
            console.log('🔄 Updating word votes:', newWordVotes);
            setWordVotes(newWordVotes);
          }
        }
        
        // Process meta votes (continue/end turn)
        if (data.type === 'meta_vote') {
          console.log('🗳️ Received meta vote:', data);
          
          // Ensure voters is always an array
          const voters = Array.isArray(data.voters) ? data.voters : [];
          
          setMetaVotes({
            action: data.action as 'continue' | 'end_turn' | 'discuss_more',
            votes: data.votes || voters.length || 0,
            voters: voters,
            percentage: data.percentage || 0
          });
        }
      } catch (error) {
        console.error('❌ Error processing WebSocket message:', error);
      }
    };
    
    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
    
    ws.onclose = () => {
      console.log('WebSocket disconnected');
    };
    
    return () => {
      ws.close();
    };
  }, [gameId]);

  // Enhanced word voting with automatic voting for high-confidence suggestions
  // and with checks for already revealed words
  const handleWordVote = async (word: string, team: string) => {
    // First check if the word has already been revealed
    if (revealedCards.includes(word)) {
      console.log(`⚠️ Cannot vote for already revealed word: "${word}"`);
      
      // Display a message that this word has already been guessed
      const alreadyGuessedMsg = {
        team,
        player: 'Game',
        message: `"${word}" has already been guessed. Please suggest a different word.`,
        timestamp: Date.now()
      };
      
      // Add feedback message to discussion
      fetch(`/api/games/${gameId}/meta/discuss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `"${word}" has already been guessed. Please suggest a different word.`,
          team,
          triggerVoting: false
        })
      }).catch(err => console.error("Error sending already guessed message:", err));
      
      return;
    }
    
    // Check if we have a custom vote handler from parent component
    if (onVote) {
      console.log(`🗳️ Using provided vote handler for "${word}" on team ${team}`);
      onVote(word, team);
      
      // Update local state optimistically
      const newWordVotes = {...wordVotes};
      if (!newWordVotes[word]) {
        newWordVotes[word] = {
          votes: 1,
          voters: [{ player: 'human', confidence: 0.9 }],
          percentage: Math.round(100 / (messages.filter(m => m.team === team).length || 1))
        };
      } else {
        newWordVotes[word].votes++;
        newWordVotes[word].voters.push({ player: 'human', confidence: 0.9 });
        // Recalculate percentage based on team members
        const teamMemberCount = messages.filter(m => m.team === team).length || 1;
        const voterCount = newWordVotes[word].voters.length;
        newWordVotes[word].percentage = Math.round((voterCount / teamMemberCount) * 100);
      }
      console.log('Optimistically updated votes state:', newWordVotes);
      setWordVotes(newWordVotes);
      return;
    }
    
    // Fall back to internal voting if no handler provided
    console.log(`🗳️ Submitting vote for word: "${word}" for team ${team} internally`);
    try {
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
      
      // Update local state
      const newWordVotes = {...wordVotes};
      if (!newWordVotes[word]) {
        newWordVotes[word] = {
          votes: 1,
          voters: [{ player: 'human', confidence: 0.9 }],
          percentage: Math.round(100 / (messages.filter(m => m.team === team).length || 1))
        };
      } else {
        newWordVotes[word].votes++;
        newWordVotes[word].voters.push({ player: 'human', confidence: 0.9 });
        // Recalculate percentage based on team members
        const teamMemberCount = messages.filter(m => m.team === team).length || 1;
        const voterCount = newWordVotes[word].voters.length;
        newWordVotes[word].percentage = Math.round((voterCount / teamMemberCount) * 100);
      }
      console.log('Updated votes state:', newWordVotes);
      setWordVotes(newWordVotes);
      
    } catch (error) {
      console.error('Error submitting vote:', error);
    }
  };
  
  // Enhanced automatic voting effect for high-confidence words
  useEffect(() => {
    if (!team || !gameId || !messages || messages.length === 0) return;
    
    // Find high-confidence suggestions from the last few messages
    const recentMessages = messages.slice(-5);
    
    // Track words that have been auto-voted
    const autoVotedWords = new Set<string>();
    
    // Get current game state to check revealed cards
    fetch(`/api/games/${gameId}`)
      .then(res => res.json())
      .then(game => {
        // Update our revealed cards state with the latest data from the server
        const serverRevealedCards = game?.revealedCards || [];
        setRevealedCards(serverRevealedCards);
        
        // Process messages to find high-confidence suggestions  
        recentMessages.forEach(msg => {
          if (!msg.suggestedWords || msg.suggestedWords.length === 0) return;
          
          // Only consider messages from the same team
          if (msg.team !== team) return;
          
          // Check for high confidence suggestions
          msg.suggestedWords.forEach((word, idx) => {
            // Skip already revealed cards
            if (serverRevealedCards.includes(word)) {
              console.log(`⚠️ Skipping already revealed card: ${word}`);
              return;
            }
            
            // Get confidence for this word
            const confidence = msg.confidences && msg.confidences[idx] !== undefined 
              ? msg.confidences[idx] 
              : (msg.confidence || 0.5);
            
            // Auto vote for high confidence words (above 0.8)
            if (confidence >= 0.8 && !autoVotedWords.has(word)) {
              console.log(`🤖 AUTO-VOTING for high confidence word: ${word} (${confidence * 100}%)`);
              
              // Use a small timeout to not spam the voting API
              setTimeout(() => {
                // Check once more that the word hasn't been revealed since we started
                if (!serverRevealedCards.includes(word)) {
                  handleWordVote(word, team);
                  autoVotedWords.add(word);
                } else {
                  console.log(`⚠️ Cancelling auto-vote - word was just revealed: ${word}`);
                }
              }, 500 * autoVotedWords.size); // Stagger auto-votes
            }
          });
        });
      })
      .catch(err => console.error("Error checking revealed cards:", err));
  }, [messages, team, gameId]);

  // New automatic effect for meta-voting (continue/end turn)
  useEffect(() => {
    if (!team || !gameId || !messages || messages.length === 0) return;
    
    // Only process the most recent messages for meta-voting
    const recentMessages = messages.slice(-5);
    
    // Look for voting messages that need automated meta voting
    const votingMessages = recentMessages.filter(msg => 
      msg.isVoting && 
      msg.voteType && 
      msg.team === team
    );
    
    // Check for recent guess messages to ensure meta decisions always happen after EVERY guess
    const guessMessages = recentMessages.filter(msg => 
      msg.player === 'Game' && 
      msg.message?.includes('Guessed:') && 
      !msg.message?.includes('wrong') && 
      !msg.message?.includes('neutral') && 
      !msg.message?.includes('opponent')
    );
    
    // More aggressive detection of correct guesses requiring meta decisions
    // This finds guesses that don't have "wrong" or similar words, meaning they were correct
    const correctGuessMessages = recentMessages.filter(msg => 
      msg.player === 'Game' && 
      msg.message?.includes('Guessed:') && 
      !msg.message?.includes('wrong') && 
      !msg.message?.includes('neutral') && 
      !msg.message?.includes('opponent') &&
      !msg.message?.includes('assassin')
    );
    
    // Check if we have any correct guesses in the recent messages
    if (correctGuessMessages.length > 0) {
      // Check if we already have a meta decision message after this guess
      const lastCorrectGuessTime = correctGuessMessages[correctGuessMessages.length - 1].timestamp || 0;
      
      // Find any meta decision that came AFTER this correct guess
      const hasMetaDecisionAfterGuess = messages.some(msg => 
        msg.isVoting && 
        msg.voteType === 'meta_decision' && 
        msg.timestamp > lastCorrectGuessTime
      );
      
      console.log(`🎮 Found correct guess at timestamp ${lastCorrectGuessTime}, hasMetaDecision: ${hasMetaDecisionAfterGuess}`);
      
      // If no meta decision exists after the most recent correct guess, create one
      if (!hasMetaDecisionAfterGuess) {
        console.log('🎮 Creating meta decision for correct guess - VOTING REQUIRED');
        
        // Create meta decision message with Among Us style UI
        const metaDecisionMsg = {
          team,
          player: 'Game',
          message: "Team must decide: continue guessing or end turn?",
          isVoting: true,
          voteType: 'meta_decision',
          timestamp: Date.now(),
          metaOptions: ['continue', 'end_turn'] // Allow UI to render the options
        };
        
        // Send via WebSocket for real-time updates - use a MORE RELIABLE approach
        if (gameId) {
          try {
            // Use fetch API to send a POST to /meta/discuss endpoint - more reliable than opening a new WebSocket
            fetch(`/api/games/${gameId}/meta/discuss`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: "Team must decide: continue guessing or end turn?",
                team,
                triggerVoting: true,
                isVoting: true,
                voteType: 'meta_decision',
                forceMeta: true // Signal this is a forced meta decision
              })
            }).catch(err => console.error("Error triggering meta vote:", err));
            
            console.log("✅ Successfully created meta decision for correct guess");
          } catch (err) {
            console.error("Failed to create meta decision:", err);
          }
        }
        
        return;
      }
    }
    
    if (votingMessages.length === 0) return;
    
    // Get the most recent voting message
    const latestVotingMsg = votingMessages[votingMessages.length - 1];
    
    // Auto-vote for continue only for Team AI members
    const shouldAutoVote = latestVotingMsg.player !== 'human' && latestVotingMsg.player !== 'Game';
    
    if (shouldAutoVote) {
      console.log(`🤖 AUTO-VOTING for meta action: ${latestVotingMsg.voteType || 'continue'}`);
      
      // Use a small delay before auto-voting
      setTimeout(() => {
        handleMetaVote(latestVotingMsg.voteType === 'end_turn' ? 'end_turn' : 'continue', team);
      }, 1500);
    }
    
    // TIMER EXPIRATION: Check for remaining time and auto-end turn if near zero
    // Find messages with time info to check for timer expiration
    const messagesWithTime = messages.filter(msg => msg.timeInfo && typeof msg.timeInfo.remainingTime === 'number');
    
    if (messagesWithTime.length > 0) {
      // Get the most recent message with time info
      const lastTimeMsg = messagesWithTime[messagesWithTime.length - 1];
      
      if (lastTimeMsg.timeInfo && lastTimeMsg.timeInfo.remainingTime <= 3) {
        // If timer is very close to expiration (3 seconds or less), auto-end turn
        console.log(`⏰ TIMER ABOUT TO EXPIRE (${lastTimeMsg.timeInfo.remainingTime}s) - Auto-ending turn`);
        
        // Auto-end turn with timer expiration flag
        setTimeout(() => {
          fetch(`/api/games/${gameId}/meta/vote`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'Game',
              team,
              action: 'end_turn',
              timerExpired: true
            })
          })
          .then(response => {
            if (!response.ok) {
              console.error('Failed to auto-end turn on timer expiration');
            } else {
              console.log('✅ Turn automatically ended due to timer expiration');
            }
          })
          .catch(error => {
            console.error('Error ending turn on timer expiration:', error);
          });
        }, 1000);
      }
    }
  }, [messages, team, gameId, onVote]);

  // ENHANCED: Handle meta voting with special fast path for ending turns
  const handleMetaVote = async (action: 'continue' | 'end_turn' | 'discuss_more', team: string) => {
    console.log(`🗳️ Submitting meta vote for action: "${action}" for team ${team}`);
    
    // Special fast path for end_turn votes to ensure immediate turn change
    if (action === 'end_turn') {
      console.log(`🔄 Fast path: Ending turn via direct meta vote`);
      
      // Create high-priority end turn vote
      try {
        // First create a UI message to show the end turn vote
        const endTurnMsg = {
          team,
          player: 'human',
          message: `Voted to end turn`,
          timestamp: Date.now(),
          isVoting: true,
          voteType: 'end_turn'
        };
        
        // Use fetch for more reliable API call
        fetch(`/api/games/${gameId}/meta/vote`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            model: 'human',
            team,
            action: 'end_turn',
            highPriority: true, // Signal this is a high-priority vote
            forceTurnChange: true // Explicitly request turn change
          })
        }).catch(err => console.error("Error submitting fast-path end turn vote:", err));
        
        // Also create multiple Game vote records to ensure threshold is met
        fetch(`/api/games/${gameId}/meta/vote`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            model: 'Game',
            team,
            action: 'end_turn',
            highPriority: true, // Signal this is a high-priority vote
            forceTurnChange: true // Explicitly request turn change
          })
        }).catch(err => console.error("Error submitting system end turn vote:", err));
        
        // Update local state immediately for responsive UI
        setMetaVotes({
          action: 'end_turn',
          votes: metaVotes.votes + 1,
          voters: [...(metaVotes.voters || []), { player: 'human', confidence: 0.9 }],
          percentage: 100 // Force to 100% to show full progress
        });
        
        // Return without waiting for response for faster UI update
        return;
      } catch (error) {
        console.error("Error in fast-path end turn vote:", error);
        // Fall through to normal path if fast path fails
      }
    }
    
    // Normal path for continue votes or fallback for end_turn
    try {
      const response = await fetch(`/api/games/${gameId}/meta/vote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'human',
          team,
          action
        })
      });
      
      if (!response.ok) {
        console.error('Failed to submit meta vote:', await response.text());
        return;
      }
      
      const result = await response.json();
      console.log('Meta vote submitted successfully:', result);
      
      // Update local state optimistically
      const teamMemberCount = messages.filter(m => m.team === team).length || 1;
      const newVoters = [...(metaVotes.voters || []), { player: 'human', confidence: 0.9 }];
      const newVoteCount = newVoters.length;
      const newPercentage = Math.round((newVoteCount / teamMemberCount) * 100);
      
      console.log('Updating meta votes:', { 
        action, 
        votes: newVoteCount, 
        voters: newVoters,
        percentage: newPercentage 
      });
      
      setMetaVotes({
        action,
        votes: newVoteCount,
        voters: newVoters,
        percentage: newPercentage
      });
      
    } catch (error) {
      console.error('Error submitting meta vote:', error);
    }
  };

  // Get model icon based on player name
  const getModelIcon = (model: string) => {
    const iconMap: {[key: string]: string} = {
      'gpt-4o': '🟢',
      'claude-3-5-sonnet-20241022': '🟣',
      'grok-2-1212': '🔴',
      'gemini-1.5-pro': '🔵',
      'human': '👤'
    };
    return iconMap[model] || '👤';
  };

  // Add animation logic for new messages
  const [animatedMessages, setAnimatedMessages] = React.useState<string[]>([]);
  
  // When messages change, gradually animate in new ones
  React.useEffect(() => {
    if (!validMessages.length) return;
    
    // Get message IDs to track which ones are animated
    const messageIds = validMessages.map(msg => `${msg.timestamp}-${msg.player}`);
    
    // Find new messages not yet animated
    const newMessageIds = messageIds.filter(id => !animatedMessages.includes(id));
    
    if (newMessageIds.length > 0) {
      console.log(`🎬 Animating ${newMessageIds.length} new messages`);
      
      // Add one message at a time with a delay
      let delay = 0;
      const addNextMessage = (index: number) => {
        if (index >= newMessageIds.length) return;
        
        setTimeout(() => {
          setAnimatedMessages(prev => [...prev, newMessageIds[index]]);
          addNextMessage(index + 1);
        }, 300); // 300ms delay between messages
      };
      
      addNextMessage(0);
    }
  }, [validMessages]);
  
  // Add a continuous debug output to check message state
  useEffect(() => {
    console.log('💬 MESSAGES STATUS CHECK:',
      validMessages.map(msg => `${msg.player}: ${msg.message?.substring(0, 20)}...`)
    );
    
    if (validMessages.length === 0) {
      console.log('⚠️ NO MESSAGES TO DISPLAY - Check WebSocket and server state');
    }
  }, [validMessages]);
  
  return (
    <div className="team-discussion" style={{
      maxHeight: '400px',
      overflowY: 'auto',
      padding: '10px',
      border: '1px solid #ccc',
      borderRadius: '4px',
      backgroundColor: '#fff'
    }}>
      {!normalizedMessages.length && <div style={{ color: 'gray', padding: '20px' }}>No messages yet</div>}
      <div style={{position: 'sticky', top: 0, backgroundColor: '#f8f9fa', padding: '4px', fontSize: '0.8em', color: '#666', zIndex: 10}}>
        <div>Message count: {normalizedMessages.length}</div>
        <div>Debug info:</div>
        <div>
          <pre style={{fontSize: '0.6em', maxHeight: '60px', overflow: 'auto'}}>
            {JSON.stringify(normalizedMessages.map(m => ({
              player: m.player, 
              msg: m.message?.substring(0, 20), 
              sw: m.suggestedWords?.length || 0,
              vt: m.isVoting
            })), null, 2)}
          </pre>
        </div>
      </div>
      {normalizedMessages.map((msg, index) => {
        // Extract team for voting
        const team = msg.team;
        
        // Get message ID
        const messageId = `${msg.timestamp}-${msg.player}`;
        const isAnimated = animatedMessages.includes(messageId);
        
        // Get voting count - NEVER skip critical messages with suggestions/voting
        const hasSuggestions = msg.suggestedWords && msg.suggestedWords.length > 0;
        const isVotingMessage = msg.isVoting || msg.voteType;
        
        // Create a stable key that helps avoid React rendering issues
        const stableKey = `${msg.timestamp}-${msg.player}-${index}-${hasSuggestions ? 'sugg' : ''}-${isVotingMessage ? 'vote' : ''}`;
        
        return (
          <div 
            key={stableKey}
            className={`message ${msg.team} ${isVotingMessage ? 'voting-message' : ''} ${hasSuggestions ? 'suggestion-message' : ''}`}
            style={{ 
              padding: '8px',
              margin: '4px',
              border: '2px solid',
              borderColor: msg.team === 'red' ? '#ff0000' : '#0000ff',
              backgroundColor: isVotingMessage ? (msg.team === 'red' ? '#fff8f8' : '#f8f8ff') : 
                               hasSuggestions ? (msg.team === 'red' ? '#ffeeee' : '#eeeeff') : '#ffffff',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              boxShadow: isVotingMessage || hasSuggestions ? '0 0 8px rgba(0,0,0,0.1)' : 'none',
              opacity: isAnimated ? 1 : 0,
              transform: isAnimated ? 'translateY(0)' : 'translateY(20px)',
              transition: 'opacity 0.3s ease-in-out, transform 0.3s ease-in-out'
            }}
          >
            <div style={{ fontSize: '0.8em', color: '#666' }}>
              {new Date(msg.timestamp).toLocaleTimeString()}
            </div>
            <div style={{ 
              display: 'flex',
              gap: '8px',
              alignItems: 'center'
            }}>
              <span style={{ 
                fontWeight: 'bold',
                color: msg.team === 'red' ? '#cc0000' : '#0066cc'
              }}>
                {msg.player}
              </span>
              <span 
                style={{ whiteSpace: 'pre-wrap' }}
                dangerouslySetInnerHTML={{ 
                  __html: msg.message ? formatMessage(msg.message) : ''
                }}
              />
            </div>
            
            {/* Only display word suggestions section if there are suggested words */}
            {hasSuggestions && (
              <div style={{
                marginTop: '8px',
                padding: '12px',
                backgroundColor: '#f8f9fa',
                borderRadius: '8px',
                border: '1px solid #dee2e6'
              }}>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: '8px',
                  borderBottom: '1px solid #eee',
                  paddingBottom: '4px'
                }}>
                  <strong>Suggested Words:</strong>
                  <span style={{ color: '#666', fontSize: '0.85em' }}>
                    {new Date(msg.timestamp).toLocaleTimeString()} • Turn time: {msg.timeInfo?.remainingTime ? `${Math.floor(msg.timeInfo.remainingTime / 60)}:${(msg.timeInfo.remainingTime % 60).toString().padStart(2, '0')}` : '1:00'} left
                  </span>
                </div>
                
                <div className="word-suggestions-list">
                  {msg.suggestedWords.map((word, idx) => {
                    // Check if the word has already been revealed
                    const isRevealed = revealedCards.includes(word);
                    
                    // Skip words that are special meta options like "CONTINUE" or "END TURN"
                    // ALSO skip already revealed words completely from suggestions list
                    if (word === "CONTINUE" || word === "END TURN" || isRevealed) return null;
                    
                    // Use the proper confidence for each word if available
                    let wordConfidence = 0.5; // Default confidence
                    
                    if (msg.confidences && msg.confidences.length > 0) {
                      if (idx < msg.confidences.length) {
                        // Use the confidence value for this specific word
                        wordConfidence = msg.confidences[idx];
                      } else {
                        // For words without specific confidence, scale down from first confidence
                        wordConfidence = Math.max(0.2, (msg.confidences[0] || 0.5) * (1 - idx * 0.15));
                      }
                    }
                    
                    // Get voting data for this word - never vote for revealed words
                    const voteData = wordVotes[word];
                    const hasVotes = voteData && voteData.votes > 0;
                    
                    // We shouldn't need this section anymore since we're filtering out 
                    // revealed words completely, but keeping minimal styling just in case
                    const revealAnimation = {
                      opacity: 1,
                      transform: 'scale(1)',
                      height: 'auto',
                      overflow: 'hidden',
                      transition: 'all 0.5s ease-in-out',
                      position: 'relative'
                    };
                    
                    // Clean styling for words (should never have revealed words displayed)
                    const textStyle = {
                      textDecoration: 'none',
                      color: idx === 0 ? '#0066cc' : '#333',
                      fontWeight: idx === 0 ? 'bold' : 'normal'
                    };
                    
                    return (
                      <div key={`word-${word}-${idx}`} style={{ 
                        marginBottom: '10px',
                        padding: '8px',
                        backgroundColor: idx === 0 ? 'rgba(240, 249, 255, 0.7)' : 'transparent',
                        borderRadius: '4px',
                        border: idx === 0 ? '1px solid #cce5ff' : 'none',
                        boxShadow: hasVotes && voteData?.percentage > 50 
                          ? '0 0 5px rgba(76, 175, 80, 0.5)' 
                          : 'none',
                        ...revealAnimation
                      }}>
                        
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          marginBottom: '6px'
                        }}>
                          <span style={{
                            fontWeight: 'bold',
                            fontSize: '1.1em',
                            ...textStyle
                          }}>
                            {word.toUpperCase()}
                          </span>
                          <span style={{
                            display: 'inline-block',
                            backgroundColor: wordConfidence > 0.7 ? '#d4f7d4' : wordConfidence > 0.4 ? '#fff3cd' : '#f8d7da',
                            padding: '2px 8px',
                            borderRadius: '12px',
                            fontWeight: 'bold',
                            color: wordConfidence > 0.7 ? '#2e7d32' : wordConfidence > 0.4 ? '#ff8f00' : '#c62828'
                          }}>
                            {`Confidence: ${Math.round(wordConfidence * 100)}%`}
                          </span>
                        </div>
                        
                        {/* Among Us style voting UI for words */}
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            marginTop: '4px',
                            padding: '4px',
                            backgroundColor: hasVotes ? 'rgba(76, 175, 80, 0.1)' : 'rgba(0,0,0,0.03)',
                            borderRadius: '4px',
                            border: hasVotes ? '1px dashed #c5e1a5' : 'none'
                          }}>
                            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                              <span title={msg.player} style={{ marginRight: '4px' }}>{getModelIcon(msg.player)}</span>
                              
                              {/* Display real voters */}
                              {hasVotes && voteData.voters.length > 0 && (
                                <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                                  <span style={{ fontSize: '0.85em', color: '#555', marginRight: '4px' }}>+</span>
                                  {voteData.voters.map((voter, vidx) => (
                                    <span key={vidx} title={voter.player}>
                                      {getModelIcon(voter.player)}
                                    </span>
                                  ))}
                                </div>
                              )}
                              
                              {/* Display voting percentage if there are votes */}
                              {hasVotes && (
                                <span style={{
                                  marginLeft: '8px',
                                  fontSize: '0.85em',
                                  backgroundColor: voteData.percentage > 70 ? '#e8f5e9' : '#f1f8e9',
                                  padding: '2px 6px',
                                  borderRadius: '10px',
                                  border: '1px solid #c5e1a5'
                                }}>
                                  {voteData.votes} votes ({voteData.percentage}%)
                                </span>
                              )}
                            </div>
                            {/* No manual vote UI - automatic voting only */}
                            <div style={{
                              fontSize: '0.8em',
                              color: '#558b2f',
                              padding: '2px 8px',
                            }}>
                              {wordConfidence > 0.7 ? "Auto-voting" : ""}
                            </div>
                          </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            
            {/* Display voting UI if agent is proposing a vote - Among Us style */}
            {isVotingMessage && (
              <div style={{
                marginTop: '12px',
                padding: '12px',
                backgroundColor: '#f0f2f5',
                borderRadius: '8px',
                border: '2px solid #d0d7de',
                boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
                animation: 'pulse 1.5s infinite'
              }}>
                <div style={{ 
                  fontWeight: 'bold', 
                  marginBottom: '8px',
                  fontSize: '1.1em',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  borderBottom: '1px solid #d0d7de',
                  paddingBottom: '6px'
                }}>
                  <span style={{
                    backgroundColor: msg.voteType === 'end_turn' ? '#ff6b6b' : '#4dabf7',
                    color: 'white',
                    padding: '4px 8px',
                    borderRadius: '12px',
                    fontSize: '0.9em'
                  }}>
                    {msg.voteType === 'end_turn' ? '⏱️ VOTE: End Turn?' : '🎮 VOTE: Continue?'}
                  </span>
                  <span style={{ fontSize: '0.8em', color: '#666' }}>
                    {new Date(msg.timestamp).toLocaleTimeString()} • Turn time: {msg.timeInfo?.remainingTime ? `${Math.floor(msg.timeInfo.remainingTime / 60)}:${(msg.timeInfo.remainingTime % 60).toString().padStart(2, '0')}` : '1:00'} left
                  </span>
                </div>
                
                {/* Voting options with Among Us style */}
                <div style={{ 
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                  marginTop: '8px'
                }}>
                  {/* Continue/Agree Option */}
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 12px',
                    backgroundColor: metaVotes.action === (msg.voteType || 'continue') ? 'rgba(76, 175, 80, 0.3)' : 'rgba(76, 175, 80, 0.1)',
                    borderRadius: '6px',
                    border: metaVotes.action === (msg.voteType || 'continue') ? '3px solid rgba(76, 175, 80, 0.7)' : '1px solid rgba(76, 175, 80, 0.3)',
                    boxShadow: metaVotes.action === (msg.voteType || 'continue') ? '0 0 10px rgba(76, 175, 80, 0.4)' : 'none',
                    position: 'relative',
                    overflow: 'hidden'
                  }}>
                    {metaVotes.action === (msg.voteType || 'continue') && (
                      <div style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '8px',
                        height: '100%',
                        backgroundColor: '#4CAF50'
                      }}/>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ 
                        fontSize: '1.2em', 
                        fontWeight: 'bold',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '5px'
                      }}>
                        {msg.voteType === 'end_turn' ? '👍 End Turn' : '👍 Continue'}
                        {metaVotes.action === (msg.voteType || 'continue') && (
                          <span style={{
                            fontSize: '0.7em',
                            backgroundColor: '#4caf50',
                            color: 'white',
                            padding: '2px 6px',
                            borderRadius: '8px',
                            fontWeight: 'bold',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '3px',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
                          }}>
                            <span style={{ fontSize: '0.9em' }}>✓</span>
                            SELECTED
                          </span>
                        )}
                      </span>
                      {/* Model icons who voted for this option */}
                      <div style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
                        {/* Always show suggesting player */}
                        <span 
                          title={msg.player}
                          style={{ 
                            backgroundColor: '#e8f5e9', 
                            borderRadius: '50%', 
                            width: '28px', 
                            height: '28px', 
                            display: 'flex', 
                            alignItems: 'center', 
                            justifyContent: 'center',
                            border: '1px solid #c8e6c9'
                          }}
                        >
                          {getModelIcon(msg.player)}
                        </span>
                        
                        {/* Display real voters if we have any */}
                        {metaVotes && metaVotes.action === (msg.voteType || 'continue') && 
                         Array.isArray(metaVotes.voters) && metaVotes.voters.length > 0 ? (
                          <>
                            <span style={{ margin: '0 2px', color: '#666', fontSize: '0.9em' }}>+</span>
                            {metaVotes.voters.filter(voter => voter.player !== msg.player).map((voter, vidx) => (
                              <span 
                                key={vidx}
                                title={voter.player}
                                style={{ 
                                  backgroundColor: '#e8f5e9', 
                                  borderRadius: '50%', 
                                  width: '28px', 
                                  height: '28px', 
                                  display: 'flex', 
                                  alignItems: 'center', 
                                  justifyContent: 'center',
                                  border: '1px solid #c8e6c9',
                                  margin: '0 2px'
                                }}
                              >
                                {getModelIcon(voter.player)}
                              </span>
                            ))}
                          </>
                        ) : null}
                      </div>
                      
                      {/* Display vote count if available */}
                      {metaVotes.action === (msg.voteType || 'continue') && metaVotes.votes > 0 && (
                        <span style={{
                          fontSize: '0.85em',
                          backgroundColor: '#e8f5e9',
                          padding: '2px 6px',
                          borderRadius: '10px'
                        }}>
                          {metaVotes.votes} votes ({metaVotes.percentage}%)
                        </span>
                      )}
                    </div>
                    {/* No manual vote button - automatic voting only */}
                    <div style={{
                      fontSize: '0.8em',
                      color: '#2e7d32',
                      padding: '2px 8px',
                    }}>
                      Auto-voting
                    </div>
                  </div>
                  
                  {/* Disagree Option */}
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 12px',
                    backgroundColor: metaVotes.action === (msg.voteType === 'end_turn' ? 'continue' : 'end_turn') ? 'rgba(244, 67, 54, 0.3)' : 'rgba(244, 67, 54, 0.1)',
                    borderRadius: '6px',
                    border: metaVotes.action === (msg.voteType === 'end_turn' ? 'continue' : 'end_turn') ? '3px solid rgba(244, 67, 54, 0.7)' : '1px solid rgba(244, 67, 54, 0.3)',
                    boxShadow: metaVotes.action === (msg.voteType === 'end_turn' ? 'continue' : 'end_turn') ? '0 0 10px rgba(244, 67, 54, 0.4)' : 'none',
                    position: 'relative',
                    overflow: 'hidden'
                  }}>
                    {metaVotes.action === (msg.voteType === 'end_turn' ? 'continue' : 'end_turn') && (
                      <div style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '8px',
                        height: '100%',
                        backgroundColor: '#F44336'
                      }}/>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ 
                        fontSize: '1.2em', 
                        fontWeight: 'bold',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '5px'
                      }}>
                        {msg.voteType === 'end_turn' ? '👎 Keep Going' : '👎 End Turn'}
                        {metaVotes.action === (msg.voteType === 'end_turn' ? 'continue' : 'end_turn') && (
                          <span style={{
                            fontSize: '0.7em',
                            backgroundColor: '#f44336',
                            color: 'white',
                            padding: '2px 6px',
                            borderRadius: '8px',
                            fontWeight: 'bold',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '3px',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
                          }}>
                            <span style={{ fontSize: '0.9em' }}>✓</span>
                            SELECTED
                          </span>
                        )}
                      </span>
                      {/* Model icons who voted for this opposite option */}
                      <div style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
                        {/* Display real voters for the opposite action */}
                        {metaVotes && metaVotes.action === (msg.voteType === 'end_turn' ? 'continue' : 'end_turn') && 
                         Array.isArray(metaVotes.voters) && metaVotes.voters.length > 0 ? (
                          <>
                            {metaVotes.voters.map((voter, vidx) => (
                              <span 
                                key={vidx}
                                title={voter.player}
                                style={{ 
                                  backgroundColor: '#ffebee', 
                                  borderRadius: '50%', 
                                  width: '28px', 
                                  height: '28px', 
                                  display: 'flex', 
                                  alignItems: 'center', 
                                  justifyContent: 'center',
                                  border: '1px solid #ffcdd2'
                                }}
                              >
                                {getModelIcon(voter.player)}
                              </span>
                            ))}
                          </>
                        ) : (
                          // Just display an example placeholder if no votes yet
                          <span style={{ 
                            backgroundColor: '#ffebee', 
                            borderRadius: '50%', 
                            width: '28px', 
                            height: '28px', 
                            display: 'flex', 
                            alignItems: 'center', 
                            justifyContent: 'center',
                            border: '1px solid #ffcdd2',
                            opacity: 0.5 // Dim it to show it's just a placeholder
                          }}>🔴</span>
                        )}
                      </div>
                    </div>
                    {/* No manual vote button - automatic voting only */}
                    <div style={{
                      fontSize: '0.8em',
                      color: '#c62828',
                      padding: '2px 8px',
                    }}>
                      {/* Empty space to maintain layout */}
                    </div>
                  </div>
                  
                  {/* Discuss More Option */}
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 12px',
                    backgroundColor: metaVotes.action === 'discuss_more' ? 'rgba(255, 152, 0, 0.3)' : 'rgba(255, 152, 0, 0.1)',
                    borderRadius: '6px',
                    border: metaVotes.action === 'discuss_more' ? '3px solid rgba(255, 152, 0, 0.7)' : '1px solid rgba(255, 152, 0, 0.3)',
                    boxShadow: metaVotes.action === 'discuss_more' ? '0 0 10px rgba(255, 152, 0, 0.4)' : 'none',
                    position: 'relative',
                    overflow: 'hidden'
                  }}>
                    {metaVotes.action === 'discuss_more' && (
                      <div style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '8px',
                        height: '100%',
                        backgroundColor: '#FF9800'
                      }}/>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ 
                        fontSize: '1.2em', 
                        fontWeight: 'bold',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '5px'
                      }}>
                        🤔 Discuss More
                        {metaVotes.action === 'discuss_more' && (
                          <span style={{
                            fontSize: '0.7em',
                            backgroundColor: '#ff9800',
                            color: 'white',
                            padding: '2px 6px',
                            borderRadius: '8px',
                            fontWeight: 'bold',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '3px',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
                          }}>
                            <span style={{ fontSize: '0.9em' }}>✓</span>
                            SELECTED
                          </span>
                        )}
                      </span>
                      {/* Model icons who voted for discuss more */}
                      <div style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
                        {metaVotes && metaVotes.action === 'discuss_more' && 
                         Array.isArray(metaVotes.voters) && metaVotes.voters.length > 0 ? (
                          <>
                            {metaVotes.voters.map((voter, vidx) => (
                              <span 
                                key={vidx}
                                title={voter.player}
                                style={{ 
                                  backgroundColor: '#fff8e1', 
                                  borderRadius: '50%', 
                                  width: '28px', 
                                  height: '28px', 
                                  display: 'flex', 
                                  alignItems: 'center', 
                                  justifyContent: 'center',
                                  border: '1px solid #ffecb3'
                                }}
                              >
                                {getModelIcon(voter.player)}
                              </span>
                            ))}
                            
                            {metaVotes.votes > 0 && (
                              <span style={{
                                marginLeft: '4px',
                                fontSize: '0.85em',
                                backgroundColor: '#fff8e1',
                                padding: '2px 6px',
                                borderRadius: '10px',
                                border: '1px solid #ffecb3'
                              }}>
                                {metaVotes.votes} votes
                              </span>
                            )}
                          </>
                        ) : (
                          <span style={{ 
                            backgroundColor: '#fff8e1', 
                            borderRadius: '50%', 
                            width: '28px', 
                            height: '28px', 
                            display: 'flex', 
                            alignItems: 'center', 
                            justifyContent: 'center',
                            border: '1px solid #ffecb3',
                            opacity: 0.5
                          }}>🔵</span>
                        )}
                      </div>
                    </div>
                    {/* No manual vote button - automatic voting only */}
                    <div style={{
                      fontSize: '0.8em',
                      color: '#f57c00',
                      padding: '2px 8px',
                    }}>
                      {/* Empty space to maintain layout */}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}