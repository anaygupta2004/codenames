import React, { useEffect, useState, useRef } from 'react';
import type { TeamDiscussionEntry, ConsensusVote } from '@shared/schema';
import { SiAnthropic } from 'react-icons/si';
import { MetaPoll } from './MetaPoll';

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
  votingInProgress?: boolean; // Add prop to indicate if voting is active
}

export function TeamDiscussion({ messages, gameId, team, onVote, votingInProgress = false }: TeamDiscussionProps) {
  // CRITICAL FIX: Track votes by individual poll ID instead of globally
  // This ensures each poll is completely independent
  const [pollStates, setPollStates] = useState<{
    [pollId: string]: {
      type: 'word' | 'meta';
      word?: string;
      action?: 'continue' | 'end_turn' | 'discuss_more';
      votes: number;
      voters: { player: string; uniqueId?: string; modelName?: string; confidence: number }[];
      percentage: number;
      timestamp: number; // When this poll was created
      messageId?: string; // Which message triggered this poll
      round?: number;    // Which discussion round
    }
  }>({});
  
  // CRITICAL FIX: No more consolidation of polls by word - each poll is completely independent
  // We need to keep track of which poll belongs to which discussion message
  const [messagePolls, setMessagePolls] = useState<{
    [messageId: string]: string; // maps message ID to poll ID
  }>({});
  
  // Helper function to get a stable message ID from a message with added uniqueness
  const getMessageId = (msg: TeamDiscussionEntry) => {
    // Extract unique ID if player has format model#uniqueid
    const uniqueId = typeof msg.player === 'string' && msg.player.includes('#') ? 
                    msg.player.split('#')[1] : 
                    // Otherwise generate a deterministic unique ID from message properties
                    `${msg.timestamp % 10000}-${Math.abs(msg.message.length % 100)}`;
    
    return `${msg.team}-${typeof msg.player === 'string' ? msg.player.split('#')[0] : msg.player}-${msg.timestamp}-${uniqueId}`;
  };
  
  // Get poll for a specific message
  const getPollForMessage = (msg: TeamDiscussionEntry) => {
    const msgId = getMessageId(msg);
    const pollId = messagePolls[msgId];
    return pollId ? pollStates[pollId] : null;
  };
  
  // CRITICAL FIX: No more single latest meta poll - each meta poll is tied to a specific message
  // This is a dummy function preserved only for backward compatibility
  const metaVotes = {
    action: 'continue' as 'continue' | 'end_turn' | 'discuss_more',
    votes: 0,
    voters: [] as { player: string; uniqueId?: string; modelName?: string; confidence: number }[],
    percentage: 0
  };
  
  // Add revealed cards state to avoid voting on already guessed words
  const [revealedCards, setRevealedCards] = useState<string[]>([]);
  
  // Debug state with more verbose info
  console.log('🗳️ TeamDiscussion component state:', { 
    pollCount: Object.keys(pollStates).length,
    messagePollsCount: Object.keys(messagePolls).length,
    teamColor: team,
    gameID: gameId,
    messageCount: messages?.length || 0
  });

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
      team: team // Log the team to track team changes
    });
    
    // Always update our local state with the latest message data
    if (messages && messages.length > 0) {
      // Update local state directly to ensure immediate UI update
      setLocalDiscussion(prev => {
        // Create a merged set without duplicates
        const newMessages = [...prev];
        const existingMsgIds = new Set(prev.map(m => `${m.timestamp}-${m.player}`));
        
        messages.forEach(msg => {
          // CRITICAL FIX: Only include messages for this team to ensure poll individualization
          if (msg.team !== team) {
            return;
          }
          
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
  }, [messages, team]); // Add team as dependency to reset on team changes
  
  // CRITICAL FIX: Reset all poll state when team changes to ensure complete individualization
  useEffect(() => {
    console.log(`🔄 Team changed to ${team} - resetting all poll states`);
    
    // Store the current team in localStorage for cross-component access
    if (team) {
      localStorage.setItem('selectedTeam', team);
    }
    
    // Reset all polling state
    setPollStates({});
    
    // Reset processed message hashes
    processedMessages.current = new Set();
    
    // Clear animated messages
    setAnimatedMessages([]);
  }, [team]); // This effect runs whenever the team changes
  
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

  // WebSocket for real-time voting - Enhanced with unique model ID handling
  useEffect(() => {
    // Store the current team in localStorage for cross-component access
    if (team) {
      localStorage.setItem('selectedTeam', team);
    }
    
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
              // CRITICAL: Only process messages from the current team to ensure individualized polls
              if (msg.team === team) {
                msg.suggestedWords.forEach(word => {
                  // Only add words that haven't been revealed yet
                  if (!game?.revealedCards?.includes(word)) {
                    wordsWithSuggestions.add(word);
                  }
                });
              }
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
        
        // CRITICAL: Also initialize from any existing consensus votes in the game state
        // This ensures we properly display votes that happened before this component mounted
        if (game?.consensusVotes?.length > 0) {
          const newWordVotes = {...wordVotes};
          
          // Group votes by word
          const votesByWord = new Map<string, { 
            votes: number, 
            voters: { player: string; uniqueId?: string; modelName?: string; confidence: number }[] 
          }>();
          
          // Process only votes for this team
          game.consensusVotes
            .filter(vote => vote.team === team)
            .forEach(vote => {
              if (!vote.word || game.revealedCards?.includes(vote.word)) return;
              
              // Extract model info from player field
              const modelParts = typeof vote.player === 'string' && vote.player.includes('#') 
                ? vote.player.split('#') 
                : [vote.player, ''];
                
              const modelName = modelParts[0];
              const uniqueId = modelParts[1];
              
              if (!votesByWord.has(vote.word)) {
                votesByWord.set(vote.word, { 
                  votes: 0, 
                  voters: [] 
                });
              }
              
              const wordData = votesByWord.get(vote.word)!;
              wordData.votes++;
              wordData.voters.push({
                player: vote.player,
                uniqueId,
                modelName,
                confidence: vote.confidence || 0.7
              });
            });
            
          // Update word votes state with votes from consensus votes
          votesByWord.forEach((voteData, word) => {
            // If we already have votes for this word, merge them
            if (newWordVotes[word]) {
              // Create a Set of uniqueIds to prevent duplicates
              const existingVoterIds = new Set(
                newWordVotes[word].voters.map(v => v.uniqueId || v.player)
              );
              
              // Only add voters that aren't already in the list
              const newVoters = [
                ...newWordVotes[word].voters,
                ...voteData.voters.filter(v => !existingVoterIds.has(v.uniqueId || v.player))
              ];
              
              newWordVotes[word] = {
                votes: newVoters.length,
                voters: newVoters,
                percentage: Math.round((newVoters.length / (messages?.filter(m => m.team === team).length || 1)) * 100)
              };
            } else {
              // If this is a new word, just add it
              newWordVotes[word] = {
                votes: voteData.votes,
                voters: voteData.voters,
                percentage: Math.round((voteData.votes / (messages?.filter(m => m.team === team).length || 1)) * 100)
              };
            }
          });
          
          console.log('📊 Initialized word votes from consensus votes:', newWordVotes);
          setWordVotes(newWordVotes);
        }
        
        // Similarly, initialize meta votes from the game state
        if (game?.metaVotes?.length > 0) {
          // Filter to only include votes for the current team's most recent action
          const teamMetaVotes = game.metaVotes.filter(v => v.team === team);
          
          if (teamMetaVotes.length > 0) {
            // Group by action
            const votesByAction = new Map<string, { 
              count: number, 
              voters: { player: string; uniqueId?: string; modelName?: string; confidence: number; reasoning?: string }[] 
            }>();
            
            teamMetaVotes.forEach(vote => {
              if (!vote.action) return;
              
              // Extract model info from player field
              const modelParts = typeof vote.player === 'string' && vote.player.includes('#') 
                ? vote.player.split('#') 
                : [vote.player, ''];
                
              const modelName = modelParts[0];
              const uniqueId = modelParts[1];
              
              if (!votesByAction.has(vote.action)) {
                votesByAction.set(vote.action, { 
                  count: 0, 
                  voters: [] 
                });
              }
              
              const actionData = votesByAction.get(vote.action)!;
              actionData.count++;
              actionData.voters.push({
                player: vote.player,
                uniqueId,
                modelName,
                confidence: vote.confidence || 0.7,
                reasoning: vote.reasoning
              });
            });
            
            // Find the action with the most votes
            let bestAction: 'continue' | 'end_turn' | 'discuss_more' = 'continue';
            let bestCount = 0;
            
            votesByAction.forEach((data, action) => {
              if (data.count > bestCount) {
                bestCount = data.count;
                bestAction = action as 'continue' | 'end_turn' | 'discuss_more';
              }
            });
            
            // Set meta vote state
            if (bestCount > 0) {
              const actionData = votesByAction.get(bestAction)!;
              setMetaVotes({
                action: bestAction,
                votes: actionData.count,
                voters: actionData.voters,
                percentage: Math.round((actionData.count / (messages?.filter(m => m.team === team).length || 1)) * 100)
              });
              
              console.log('📊 Initialized meta votes from game state:', { 
                action: bestAction, 
                count: actionData.count 
              });
            }
          }
        }
      } catch (error) {
        console.error("Error initializing from messages:", error);
      }
    };
    
    // Run initialization
    initFromMessages();
    
    // Generate a model-specific unique ID for this client session
    // This ensures each "instance" of a model gets a unique identifier
    const generateUniqueModelId = () => {
      // Get base client ID from localStorage
      const clientId = localStorage.getItem('clientId') || (() => {
        const newId = Math.random().toString(36).substring(7);
        localStorage.setItem('clientId', newId);
        return newId;
      })();
      
      // Generate a 5-digit unique ID for this session
      const uniqueId = Math.floor(10000 + Math.random() * 90000).toString();
      
      console.log(`🔑 Generated unique 5-digit model ID: ${uniqueId}`);
      return {
        clientId,
        uniqueId
      };
    };
    
    // Get unique IDs for this session
    const { clientId, uniqueId } = generateUniqueModelId();
    
    // Setup WebSocket connection to receive votes
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
      console.log('WebSocket connected for voting');
      if (gameId) {
        // Join the game with enhanced client identification including unique model ID
        ws.send(JSON.stringify({ 
          type: 'join', 
          gameId,
          clientId,
          uniqueId, // Include the unique model ID
          team  // Also include the team explicitly
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
            console.log('✅ Correct guess by team - checking if meta decision needed');
            
            // Check if a meta decision was recently created for this team
            try {
              const existingDecisions = JSON.parse(localStorage.getItem('recentMetaDecisions') || '[]');
              
              // Check if we recently created a meta decision for this same team
              const isDuplicate = existingDecisions.some((decision: any) => 
                decision.team === team && 
                (Date.now() - decision.timestamp < 10000) // Within last 10 seconds
              );
              
              if (isDuplicate) {
                console.log(`⚠️ TeamDiscussion: Skipping duplicate meta decision for team ${team}`);
                return;
              }
              
              console.log('TeamDiscussion: No recent meta decision found - creating one');
              
              // Create a unique meta decision ID that includes more context
              // This ensures better matching of polls with their associated votes
              const metaDecisionId = `meta-${team}-${data.word}-${Date.now()}-choice`;
              
              // Track this decision to prevent duplicates
              existingDecisions.push({
                id: metaDecisionId,
                team: team,
                word: data.word,
                timestamp: Date.now(),
                type: 'meta_vote' // Add type for better tracking
              });
              
              // Keep only the 5 most recent decisions
              if (existingDecisions.length > 5) {
                existingDecisions.shift();
              }
              
              localStorage.setItem('recentMetaDecisions', JSON.stringify(existingDecisions));
              
              // Send a meta decision message only if no recent one exists
              setTimeout(() => {
                fetch(`/api/games/${gameId}/meta/discuss`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    message: "Should we continue guessing or end turn?",
                    team,
                    triggerVoting: true,
                    uniqueId,
                    pollId: metaDecisionId // Use consistent poll ID
                  })
                }).catch(err => console.error("Error triggering meta vote:", err));
              }, 1000);
            } catch (error) {
              console.error("Error checking for duplicate meta decisions:", error);
            }
          }
        }
        
        // Process word votes - Completely rewritten for truly independent polls tied to specific messages
        if (data.type === 'word_votes') {
          console.log('🗳️ Received word votes:', data);
          
          // CRITICAL FIX: Only process votes for the current team to ensure individualized polls
          if (data.team !== team) {
            console.log(`⏭️ Skipping votes for team ${data.team} since we're on team ${team}`);
            return;
          }
          
          // Check if this poll has a messageId to link it to a specific message
          if (!data.messageId) {
            console.log(`⚠️ Received vote without messageId - cannot link to a message`);
            // We still process but won't link it to a message
          }
          
          // SUPER IMPORTANT - Check if we already have a poll with this ID to prevent duplicates
          if (data.pollId && pollStates[data.pollId]) {
            console.log(`⚠️ Duplicate poll ID detected (${data.pollId}) - skipping to prevent duplicates`);
            return;
          }
          
          // Use the pollStates structure - each word vote is a separate poll with its own ID
          // MUST use the pollId from the server if available - never consolidate polls!
          const pollId = data.pollId || `word-${team}-${data.messageId || ''}-${data.timestamp || Date.now()}`;
          
          if (Array.isArray(data.words)) {
            data.words.forEach((wordData: any) => {
              // Skip votes for already revealed words
              if (wordData?.word && !revealedCards.includes(wordData.word)) {
                // Process voters to extract uniqueIds and modelNames
                const processedVoters = Array.isArray(wordData.voters) 
                  ? wordData.voters.map((voter: any) => {
                      // Extract base model and uniqueId if present
                      let baseModel = voter.player;
                      let voterUniqueId = '';
                      
                      if (typeof voter.player === 'string') {
                        if (voter.player.includes('#')) {
                          const parts = voter.player.split('#');
                          baseModel = parts[0];
                          voterUniqueId = parts[1];
                        } else if (voter.player.includes('-')) {
                          const parts = voter.player.split('-');
                          if (VALID_MODELS.includes(parts[0] as any)) {
                            baseModel = parts[0];
                            voterUniqueId = parts.slice(1).join('-');
                          }
                        }
                      }
                      
                      return {
                        ...voter,
                        player: voter.player, // Keep original player ID
                        modelName: baseModel, // Add base model name
                        uniqueId: voterUniqueId || voter.uniqueId // Add unique ID if present
                      };
                    })
                  : [];
                
                // Create a completely separate poll with this poll ID
                setPollStates(prev => ({
                  ...prev,
                  [pollId]: {
                    type: 'word',
                    word: wordData.word,
                    votes: wordData.votes || 0,
                    voters: processedVoters,
                    percentage: wordData.percentage || 0,
                    timestamp: data.timestamp || Date.now(),
                    // Link to specific message if possible
                    messageId: data.messageId
                  }
                }));
                
                // If this poll has a messageId, update the messagePolls mapping to track which poll goes with which message
                if (data.messageId) {
                  setMessagePolls(prev => ({
                    ...prev,
                    [data.messageId]: pollId
                  }));
                  console.log(`📎 Linked poll ${pollId} to message ${data.messageId}`);
                }
              }
            });
          }
        }
        
        // Process meta votes (continue/end turn) - Completely rewritten for truly independent polls tied to specific messages
        if (data.type === 'meta_vote') {
          console.log('🗳️ Received meta vote:', data);
          
          // CRITICAL FIX: Only process meta votes for the current team to ensure individualized polls
          if (data.team !== team) {
            console.log(`⏭️ Skipping meta vote for team ${data.team} since we're on team ${team}`);
            return;
          }
          
          // Check if this poll has a messageId to link it to a specific message
          if (!data.messageId) {
            console.log(`⚠️ Received meta vote without messageId - cannot link to a message`);
            // We still process but won't link it to a message
          }
          
          // SUPER IMPORTANT - Check if we already have a poll with this ID to prevent duplicates
          if (data.pollId && pollStates[data.pollId]) {
            console.log(`⚠️ Duplicate meta poll ID detected (${data.pollId}) - skipping to prevent duplicates`);
            return;
          }
          
          // Use the pollStates structure - each meta vote is its own poll with its own ID
          // MUST use the pollId from the server - never consolidate meta polls!
          const pollId = data.pollId || `meta-${team}-${data.messageId || ''}-${data.action}-${data.timestamp || Date.now()}`;
          
          // Ensure voters is always an array
          const voters = Array.isArray(data.voters) ? data.voters : [];
          
          // Process voters to extract uniqueIds and modelNames
          const processedVoters = voters.map((voter: any) => {
            // Extract base model and uniqueId if present
            let baseModel = voter.player || voter.baseModel;
            let voterUniqueId = '';
            
            if (typeof baseModel === 'string') {
              if (baseModel.includes('#')) {
                const parts = baseModel.split('#');
                baseModel = parts[0];
                voterUniqueId = parts[1];
              } else if (baseModel.includes('-')) {
                const parts = baseModel.split('-');
                if (VALID_MODELS.includes(parts[0] as any)) {
                  baseModel = parts[0];
                  voterUniqueId = parts.slice(1).join('-');
                }
              }
            }
            
            return {
              ...voter,
              player: voter.player, // Keep original player ID
              modelName: baseModel, // Add base model name
              uniqueId: voterUniqueId || voter.uniqueId // Add unique ID if present
            };
          });
          
          // Create a completely separate poll with this poll ID
          setPollStates(prev => ({
            ...prev,
            [pollId]: {
              type: 'meta',
              action: data.action as 'continue' | 'end_turn' | 'discuss_more',
              votes: data.votes || processedVoters.length || 0,
              voters: processedVoters,
              percentage: data.percentage || 0,
              timestamp: data.timestamp || Date.now(),
              // Link to specific message if available
              messageId: data.messageId
            }
          }));
          
          // If this poll has a messageId, update the messagePolls mapping to track which poll goes with which message
          if (data.messageId) {
            setMessagePolls(prev => ({
              ...prev,
              [data.messageId]: pollId
            }));
            console.log(`📎 Linked meta poll ${pollId} to message ${data.messageId}`);
          }
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
  }, [gameId, team]); // Added team as dependency to ensure proper filtering

  // Completely rewritten word voting for truly independent polls tied to specific messages
  const handleWordVote = async (word: string, team: string, messageId: string) => {
    // Check if voting is in progress - if so, prevent voting
    if (votingInProgress) {
      console.log(`⚠️ Cannot vote while voting is in progress`);
      return;
    }

    // First check if the word has already been revealed
    if (revealedCards.includes(word)) {
      console.log(`⚠️ Cannot vote for already revealed word: "${word}"`);
      
      // Display a message that this word has already been guessed
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
    
    // Generate a unique ID for this model instance if not already present
    // This prevents multiple votes from the same model instance
    const generateUniqueId = () => {
      // Generate a 5-digit unique ID for this player/vote
      return Math.floor(10000 + Math.random() * 90000).toString();
    };
    
    // Get or create unique ID for this human player
    const uniqueId = localStorage.getItem('humanUniqueId') || (() => {
      const newId = generateUniqueId();
      localStorage.setItem('humanUniqueId', newId);
      return newId;
    })();
    
    // CRITICAL: Create a COMPLETELY NEW poll for this vote 
    // This ensures each word vote is an independent poll
    const timestamp = Date.now();
    
    // The poll ID now includes the messageId to ensure it's tied to a specific message
    const newPollId = `word-${team}-${messageId}-${timestamp}`;
    
    // Check if we have a custom vote handler from parent component
    if (onVote) {
      console.log(`🗳️ Using provided vote handler for "${word}" on team ${team} with uniqueId ${uniqueId}`);
      onVote(word, team);
      
      // Create a new poll for this vote
      const teamMemberCount = messages.filter(m => m.team === team).length || 1;
      
      // Update pollStates with this new independent poll tied to this specific message
      setPollStates(prev => ({
        ...prev,
        [newPollId]: {
          type: 'word',
          word: word,
          votes: 1,
          voters: [{ 
            player: `human#${uniqueId}`, 
            uniqueId, 
            modelName: 'human', 
            confidence: 0.9 
          }],
          percentage: Math.round(100 / teamMemberCount),
          timestamp: timestamp,
          // Now we explicitly store which message this poll belongs to
          messageId: messageId
        }
      }));
      
      // Also update the messagePolls map to track which poll belongs to which message
      setMessagePolls(prev => ({
        ...prev,
        [messageId]: newPollId
      }));
      
      return;
    }
    
    // Fall back to internal voting if no handler provided
    console.log(`🗳️ Creating new independent poll for word "${word}" for team ${team} with ID ${newPollId}`);
    try {
      // Create the player model ID with unique identifier to prevent duplicate voting
      const playerModel = `human#${uniqueId}`;
      
      // Add pollId and messageId to the request to ensure server knows exactly which message/poll this belongs to
      const response = await fetch(`/api/games/${gameId}/ai/vote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: playerModel, // Use model ID with unique identifier
          team,
          word,
          uniqueId, // Also send the unique ID separately for server tracking
          pollId: newPollId, // Send the poll ID to identify this specific poll
          messageId: messageId // Which message this poll is for
        })
      });
      
      if (!response.ok) {
        console.error('Failed to submit vote:', await response.text());
        return;
      }
      
      const result = await response.json();
      console.log('Vote submitted successfully:', result);
      
      // Get the actual team operatives count for more accurate percentage
      // Fetch the current game to get accurate team members
      fetch(`/api/games/${gameId}`)
        .then(res => res.json())
        .then(game => {
          const isRedTeam = team === 'red';
          const teamPlayers = isRedTeam ? game.redPlayers : game.bluePlayers;
          const spymaster = isRedTeam ? game.redSpymaster : game.blueSpymaster;
          // Calculate operatives (team members excluding spymaster)
          const operativesCount = teamPlayers ? teamPlayers.filter(p => p !== spymaster).length : 1;
          
          console.log(`Team ${team} has ${operativesCount} operatives for vote calculation`);
          
          // Get response with game data for adding reasoning
          const voteResult = await result;
          
          // Create a new independent poll in our pollStates tied to this specific message
          setPollStates(prev => ({
            ...prev,
            [newPollId]: {
              type: 'word',
              word: word,
              votes: 1,
              voters: [{ 
                player: playerModel, 
                uniqueId,
                modelName: 'human', 
                confidence: 0.9,
                reasoning: "Human player voted for this word based on clue and game state"
              }],
              percentage: Math.round(100 / operativesCount),
              timestamp: timestamp,
              // Store the exact message this poll belongs to
              messageId: messageId,
              // Store game state information when vote happened
              clueGuessCount: voteResult?.vote?.clueGuessCount,
              gameScore: voteResult?.vote?.gameScore
            }
          }));
        });
      
      // Also update the messagePolls map to track which poll belongs to which message
      setMessagePolls(prev => ({
        ...prev,
        [messageId]: newPollId
      }));
      
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
    
    // Create a unique identifier for each meta decision session to prevent duplicates
    const [activeMetaDecisionId, setActiveMetaDecisionId] = useState<string | null>(null);
    
    // Only process the most recent messages for meta-voting
    const recentMessages = messages.slice(-5);
    
    // Look for voting messages that need automated meta voting
    const votingMessages = recentMessages.filter(msg => 
      msg.isVoting && 
      msg.voteType && 
      msg.team === team
    );
    
    // Check for recent guess messages to ensure meta decisions always happen after EVERY guess
    // But only one meta decision per turn
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
      
      // Get the timestamp of the most recent meta decision in this game
      const mostRecentMetaDecision = messages
        .filter(msg => msg.isVoting && msg.voteType === 'meta_decision')
        .sort((a, b) => b.timestamp - a.timestamp)[0];
      
      const mostRecentMetaTimestamp = mostRecentMetaDecision?.timestamp || 0;
      
      // Only create ONE meta decision right after a correct guess
      // if one doesn't already exist AND we don't have an active meta decision
      // AND the most recent meta decision was a while ago (at least 5 seconds)
      const needsNewMetaDecision = 
        !hasMetaDecisionAfterGuess && 
        !activeMetaDecisionId &&
        (Date.now() - mostRecentMetaTimestamp > 5000);
      
      console.log(`🎮 Found correct guess at timestamp ${lastCorrectGuessTime}, hasMetaDecision: ${hasMetaDecisionAfterGuess}, needsNew: ${needsNewMetaDecision}`);
      
      // If no meta decision exists after the most recent correct guess, create one
      if (needsNewMetaDecision) {
        console.log('🎮 Checking if meta decision is needed');
        
        // Check if a meta decision was recently created for this team
        try {
          const existingDecisions = JSON.parse(localStorage.getItem('recentMetaDecisions') || '[]');
          
          // Check if we recently created a meta decision for this same team
          const isDuplicate = existingDecisions.some((decision: any) => 
            decision.team === team && 
            (Date.now() - decision.timestamp < 10000) // Within last 10 seconds
          );
          
          if (isDuplicate) {
            console.log(`⚠️ Effect: Skipping duplicate meta decision for team ${team}`);
            return;
          }
          
          console.log('🎮 Creating meta decision for correct guess - VOTING REQUIRED');
          
          // Generate a unique ID for this meta decision session with action context
          // Format ensures better matching with votes in the MetaPoll component
          const newMetaDecisionId = `meta-${team}-effect-${Date.now()}-meta-choice`;
          setActiveMetaDecisionId(newMetaDecisionId);
          
          // Track this decision to prevent duplicates
          existingDecisions.push({
            id: newMetaDecisionId,
            team: team,
            word: 'effect-trigger',
            timestamp: Date.now(),
            type: 'meta_vote', // Add type for better tracking
            meta: true // Explicit flag to identify as meta decision
          });
          
          // Keep only the 5 most recent decisions
          if (existingDecisions.length > 5) {
            existingDecisions.shift();
          }
          
          localStorage.setItem('recentMetaDecisions', JSON.stringify(existingDecisions));
          
          // Create meta decision message with Among Us style UI
          const metaDecisionMsg = {
            team,
            player: 'Game',
            message: "Team must decide: continue guessing or end turn?",
            isVoting: true,
            voteType: 'meta_decision',
            timestamp: Date.now(),
            metaOptions: ['continue', 'end_turn'], // Allow UI to render the options
            pollId: newMetaDecisionId, // Use standardized poll ID field
            metaDecisionId: newMetaDecisionId // Add unique ID to prevent duplicates
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
                  forceMeta: true, // Signal this is a forced meta decision
                  pollId: newMetaDecisionId, // Use standardized poll ID field
                  metaDecisionId: newMetaDecisionId // Include the unique ID
                })
              }).catch(err => console.error("Error triggering meta vote:", err));
              
              console.log("✅ Successfully created meta decision for correct guess");
            } catch (err) {
              console.error("Failed to create meta decision:", err);
            }
          }
        } catch (error) {
          console.error("Error checking for duplicate meta decisions in effect:", error);
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

  // Completely rewritten meta voting for truly independent polls tied to specific messages
  const handleMetaVote = async (action: 'continue' | 'end_turn' | 'discuss_more', team: string, messageId?: string) => {
    // Check if voting is already in progress - if so, prevent submitting more votes
    if (votingInProgress) {
      console.log(`⚠️ Cannot submit meta vote while voting is already in progress`);
      return;
    }
    
    // CRITICAL FIX: Ensure we have a valid messageId and it's consistent with any pollId
    // If messageId looks like a pollId, it's likely passed from the MetaPoll component
    const isPollId = messageId && messageId.startsWith('meta-');
    const pollId = isPollId ? messageId : undefined;
    
    // Use the messageId if provided or generate a stable one
    const actualMessageId = messageId || `meta-${team}-${Date.now()}`;
    
    console.log(`🗳️ Creating new meta vote: action="${action}", team=${team}, messageId=${actualMessageId}, pollId=${pollId || 'auto-generated'}`);
    
    // Generate a unique ID for this model instance if not already present
    // This prevents multiple votes from the same model instance
    const generateUniqueId = () => {
      // Generate a 5-digit unique ID for this player/vote
      return Math.floor(10000 + Math.random() * 90000).toString();
    };
    
    // Get or create unique ID for this human player
    const uniqueId = localStorage.getItem('humanMetaUniqueId') || (() => {
      const newId = generateUniqueId();
      localStorage.setItem('humanMetaUniqueId', newId);
      return newId;
    })();
    
    // Create the player model ID with unique identifier to prevent duplicate voting
    const playerModel = `human#${uniqueId}`;
    
    // Create reasoning text based on action
    const reasoning = action === 'end_turn' 
      ? "I think we should end our turn to avoid making a mistake."
      : action === 'continue'
      ? "I think we should continue guessing since we have a good chance of getting another word."
      : "I think we need to discuss this more before deciding.";
    
    // CRITICAL: Create a COMPLETELY NEW poll for this vote tied to a specific message
    // This ensures each meta vote is an independent poll with its own ID
    const timestamp = Date.now();
    // If we have a pollId, prioritize it for consistency, otherwise generate one
    const newPollId = pollId || `meta-${team}-${actualMessageId}-${timestamp}`;
    
    // Store this mapping for future reference
    try {
      const pollMessageMap = JSON.parse(localStorage.getItem('pollMessageIdMap') || '{}');
      pollMessageMap[newPollId] = actualMessageId;
      localStorage.setItem('pollMessageIdMap', JSON.stringify(pollMessageMap));
      console.log(`📝 Stored poll-message mapping: ${newPollId} → ${actualMessageId}`);
    } catch (e) {
      console.error("Error storing poll-message mapping:", e);
    }
    
    // IMPROVED: Handle end_turn votes consistently with other meta votes
    // This ensures the game waits for team decision without bypassing the normal vote flow
    if (action === 'end_turn') {
      console.log(`🔄 Creating standard vote for ending turn with ID ${newPollId}`);
      
      try {
        // Use fetch for API call with uniqueId, pollId and messageId
        fetch(`/api/games/${gameId}/meta/vote`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            model: playerModel, // Use model ID with unique identifier
            team,
            action: 'end_turn',
            // No longer using highPriority or forceTurnChange to ensure proper game flow
            reasoning, // Include reasoning for game log
            uniqueId, // Include uniqueId for server tracking
            pollId: newPollId, // Use consistent poll ID
            messageId: actualMessageId // Tie this poll to a specific message
          })
        }).catch(err => console.error("Error submitting end turn vote:", err));
        
        // Update local state for responsive UI, but use normal flow
        setPollStates(prev => ({
          ...prev,
          [newPollId]: {
            type: 'meta',
            action: 'end_turn',
            votes: 1,
            voters: [{ 
              player: playerModel, 
              uniqueId, 
              modelName: 'human',
              confidence: 0.9, 
              reasoning
            }],
            // Don't force to 100% anymore - show actual progress based on team size
            percentage: Math.round(100 / (teamMemberCount || 1)), 
            timestamp: timestamp,
            messageId: actualMessageId // Store which message this poll belongs to
          }
        }));
        
        // Also update the messagePolls map to track which poll belongs to which message
        setMessagePolls(prev => ({
          ...prev,
          [actualMessageId]: newPollId
        }));
        
        // Don't return early - let the normal vote processing flow continue
      } catch (error) {
        console.error("Error in end turn vote:", error);
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
          model: playerModel, // Use model ID with unique identifier
          team,
          action,
          reasoning, // Include reasoning for game log
          uniqueId, // Include uniqueId for server tracking
          pollId: newPollId, // Identify this specific poll instance
          messageId: actualMessageId, // Tie this poll to a specific message
          originalPollId: pollId // Include the original pollId if it was provided from a component
        })
      });
      
      if (!response.ok) {
        console.error('Failed to submit meta vote:', await response.text());
        return;
      }
      
      const result = await response.json();
      console.log('Meta vote submitted successfully:', result);
      
      // Calculate percentage based on team members for this poll
      const teamMemberCount = messages.filter(m => m.team === team).length || 1;
      
      // Create a completely new poll for this meta vote in our poll states
      // The key difference is we need to use an action-specific poll ID
      // This ensures each action (continue/end_turn/discuss_more) has its own poll
      const actionPollId = `${newPollId}-${action}`;
      
      setPollStates(prev => {
        // Check if we already have a poll for this action on this message
        console.log(`🔍 Looking for existing poll for action ${action} on message ${actualMessageId}`);
        const existingPoll = Object.values(prev)
          .find(p => 
            p.type === 'meta' && 
            p.action === action && 
            p.messageId === actualMessageId
          );
        
        if (existingPoll) {
          // If poll exists, just update it with a new voter rather than creating a new one
          const pollId = Object.keys(prev).find(id => prev[id] === existingPoll);
          
          if (pollId) {
            // Update existing poll
            return {
              ...prev,
              [pollId]: {
                ...existingPoll,
                votes: existingPoll.votes + 1,
                voters: [
                  ...existingPoll.voters,
                  { 
                    player: playerModel, 
                    uniqueId,
                    modelName: 'human', 
                    confidence: 0.9,
                    reasoning
                  }
                ],
                // Recalculate percentage based on new vote count
                percentage: Math.round((existingPoll.votes + 1) / teamMemberCount * 100)
              }
            };
          }
        }
        
        // If no existing poll, create a new one
        return {
          ...prev,
          [actionPollId]: {
            type: 'meta',
            action,
            votes: 1,
            voters: [{ 
              player: playerModel, 
              uniqueId,
              modelName: 'human', 
              confidence: 0.9,
              reasoning
            }],
            percentage: Math.round(100 / teamMemberCount),
            timestamp,
            messageId: actualMessageId // Store which message this poll belongs to
          }
        };
      });
      
      // Also update the messagePolls map to track which poll belongs to which message
      // Use the action-specific poll ID to ensure correct poll mapping
      setMessagePolls(prev => ({
        ...prev,
        [`${actualMessageId}-${action}`]: actionPollId
      }));
      
    } catch (error) {
      console.error('Error submitting meta vote:', error);
    }
  };

  // Enhanced getModelIcon function to handle unique IDs and improve icon selection
  const getModelIcon = (model: string) => {
    // Extract base model name from any format (model#uniqueId, model-timestamp, etc.)
    let baseModel = model;
    let uniqueId = '';
    
    // Handle various formats of model IDs
    if (model.includes('#')) {
      // Handle the new format model#uniqueid
      const parts = model.split('#');
      baseModel = parts[0];
      uniqueId = parts[1];
    } else if (model.includes('-')) {
      // Handle older timestamp format or other formats with hyphens
      const parts = model.split('-');
      if (VALID_MODELS.includes(parts[0] as any)) {
        baseModel = parts[0];
        uniqueId = parts.slice(1).join('-');
      }
    }
    
    // Complete map of models to visual icons with proper branding
    const iconMap: {[key: string]: string} = {
      // AI Models
      'gpt-4o': 'SiOpenai', // OpenAI
      'claude-3-5-sonnet-20241022': 'SiAnthropic', // Anthropic
      'grok-2-1212': 'SiXdotai', // Grok (xAI)
      'gemini-1.5-pro': 'SiGoogle', // Google
      'llama-7b': 'SiMeta', // Meta
      
      // Human users
      'human': '👤', // Human player
      'human-player': '👤', // Human player from home page
      
      // System
      'Game': '🎮'  // Game system messages
    };
    
    // Get the appropriate icon for this model
    const icon = iconMap[baseModel];
    
    // Log for debugging (include uniqueId for visibility)
    console.log(`Icon lookup: ${model} → base=${baseModel}, id=${uniqueId} → icon=${icon || '👤'}`);
    
    // Actually get and render icon components
    if (icon === 'SiOpenai') return '🟢'; // OpenAI
    if (icon === 'SiAnthropic') return '🟣'; // Anthropic
    if (icon === 'SiXdotai') return '🔴'; // Grok (xAI)
    if (icon === 'SiGoogle') return '🔵'; // Google
    if (icon === 'SiMeta') return '🟡'; // Meta
    
    // Return the icon or default to human icon if unknown
    return icon || '👤';
  };
  
  // Define valid models for icon lookup - MUST match the home page model definitions
  const VALID_MODELS = ['gpt-4o', 'claude-3-5-sonnet-20241022', 'grok-2-1212', 'gemini-1.5-pro', 'llama-7b', 'human-player'];

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
      backgroundColor: '#fff',
      position: 'relative' // Required for absolute positioning of overlay
    }}>
      {/* Voting Overlay - Show when voting is in progress */}
      {votingInProgress && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          zIndex: 100,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          borderRadius: '4px',
          color: 'white',
          textAlign: 'center',
          padding: '20px'
        }}>
          <div style={{ fontSize: '24px', fontWeight: 'bold', marginBottom: '10px' }}>Voting in Progress</div>
          <div style={{ fontSize: '16px' }}>Please wait while team members cast their votes...</div>
        </div>
      )}
      {!normalizedMessages.length && <div style={{ color: 'gray', padding: '20px' }}>No messages yet</div>}
      <div style={{position: 'sticky', top: 0, backgroundColor: '#f8f9fa', padding: '4px', fontSize: '0.8em', color: '#666', zIndex: 10}}>
        <div>Team: {team} - Message count: {normalizedMessages.length}</div>
        <div>Poll State: {Object.keys(wordVotes).length} word votes, {metaVotes.voters?.length || 0} meta votes</div>
      </div>
      
      {/* CRITICAL FIX: Filter messages to only show those for the current team */}
      {normalizedMessages
        .filter(msg => msg.team === team) // Only show messages for this team's discussion
        .map((msg, index) => {
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
              <div style={{ 
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                width: '100%'
              }}>
                <span style={{ 
                  fontWeight: 'bold',
                  color: msg.team === 'red' ? '#cc0000' : '#0066cc'
                }}>
                  {/* Display player name, icon, and ID */}
                  {getModelIcon(msg.player)}
                  {' '}
                  {typeof msg.player === 'string' && msg.player.includes('#') 
                    ? `${msg.player.split('#')[0]} (ID: ${msg.player.split('#')[1].substring(0, 5)})`
                    : msg.player}
                </span>
                
                {/* Display unique ID in top right for ALL messages */}
                <span style={{
                  fontSize: '0.75em',
                  backgroundColor: '#f0f0f0',
                  padding: '2px 6px',
                  borderRadius: '12px',
                  color: '#666',
                  marginLeft: 'auto'
                }}>
                  ID: {(() => {
                    // Generate a stable ID for this message
                    const msgId = getMessageId(msg);
                    // Extract last 5 characters for display
                    return msgId.substring(Math.max(0, msgId.length - 5));
                  })()}
                </span>
              </div>
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
                    
                    // CRITICAL FIX: Get the message-specific poll for this word
                    // This ensures we're showing the correct poll for this specific message/suggestion
                    const messageId = getMessageId(msg);
                    const pollId = messagePolls[messageId];
                    const messagePoll = pollId ? pollStates[pollId] : null;
                    
                    // Only consider this specific poll for this message - no consolidation!
                    const hasVotes = messagePoll && 
                                    messagePoll.type === 'word' && 
                                    messagePoll.word === word && 
                                    messagePoll.voters && 
                                    messagePoll.voters.length > 0;
                    
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
                        boxShadow: hasVotes && messagePoll?.percentage > 50 
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
                              
                              {/* Display real voters - from the message-specific poll */}
                              {hasVotes && messagePoll && messagePoll.voters && messagePoll.voters.length > 0 && (
                                <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                                  <span style={{ fontSize: '0.85em', color: '#555', marginRight: '4px' }}>+</span>
                                  {messagePoll.voters.map((voter, vidx) => {
                                    // Extract model name and ID for display
                                    let modelName = voter.player;
                                    let modelId = '';
                                    
                                    if (typeof voter.player === 'string' && voter.player.includes('#')) {
                                      const parts = voter.player.split('#');
                                      modelName = parts[0];
                                      modelId = parts[1].substring(0, 5);
                                    }
                                    
                                    // Build tooltip with reasoning + game info
                                    const tooltipText = voter.reasoning 
                                      ? `${modelName} [${modelId}]: ${voter.reasoning}`
                                      : `${modelName} [${modelId}]`;
                                      
                                    const gameInfo = messagePoll.gameScore 
                                      ? `\nScore: Red ${messagePoll.gameScore.red} - Blue ${messagePoll.gameScore.blue}`
                                      : '';
                                      
                                    const clueInfo = messagePoll.clueGuessCount !== undefined
                                      ? `\nGuesses with this clue: ${messagePoll.clueGuessCount}`
                                      : '';
                                    
                                    return (
                                      <span 
                                        key={vidx} 
                                        title={tooltipText + gameInfo + clueInfo}
                                        style={{ 
                                          padding: '3px',
                                          backgroundColor: '#e8f5e9',
                                          borderRadius: '50%',
                                          border: '1px solid #c8e6c9',
                                          position: 'relative'
                                        }}
                                      >
                                        {getModelIcon(voter.player)}
                                        {modelId && (
                                          <span style={{
                                            position: 'absolute',
                                            top: '-5px',
                                            right: '-5px',
                                            fontSize: '0.6em',
                                            backgroundColor: '#f0f0f0',
                                            padding: '1px 3px',
                                            borderRadius: '8px',
                                            color: '#666'
                                          }}>
                                            {modelId}
                                          </span>
                                        )}
                                      </span>
                                    );
                                  })}
                                </div>
                              )}
                              
                              {/* Display voting percentage if there are votes - from the message-specific poll */}
                              {hasVotes && messagePoll && (
                                <span style={{
                                  marginLeft: '8px',
                                  fontSize: '0.85em',
                                  backgroundColor: messagePoll.percentage > 70 ? '#e8f5e9' : '#f1f8e9',
                                  padding: '2px 6px',
                                  borderRadius: '10px',
                                  border: '1px solid #c5e1a5'
                                }}>
                                  {messagePoll.votes} votes ({messagePoll.percentage}%)
                                </span>
                              )}
                            </div>
                            {/* Add manual vote UI for each specific message */}
                            <div style={{
                              fontSize: '0.8em',
                              color: '#558b2f',
                              padding: '2px 8px',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px'
                            }}>
                              {wordConfidence > 0.7 ? "Auto-voting" : ""}
                              
                              {/* Add vote button that passes specific message ID - disable during voting */}
                              <button 
                                onClick={() => handleWordVote(word, team, getMessageId(msg))}
                                disabled={votingInProgress}
                                style={{
                                  fontSize: '0.85em',
                                  padding: '2px 8px',
                                  backgroundColor: votingInProgress ? '#cccccc' : '#4CAF50',
                                  color: 'white',
                                  border: 'none',
                                  borderRadius: '4px',
                                  cursor: votingInProgress ? 'not-allowed' : 'pointer',
                                  opacity: votingInProgress ? 0.7 : 1
                                }}
                              >
                                {votingInProgress ? 'Voting...' : 'Vote'}
                              </button>
                            </div>
                          </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            
            {/* Display voting UI if agent is proposing a vote - use MetaPoll component for each poll */}
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
                
                {/* Use MetaPoll component with message ID as poll ID to ensure independence */}
                <MetaPoll 
                  pollId={msg.pollId || `meta-${team}-${getMessageId(msg)}`}
                  team={team}
                  gameId={gameId || 0}
                  timestamp={msg.timestamp}
                  messageId={msg.pollId || getMessageId(msg)} // Use pollId as messageId if available
                  votingInProgress={votingInProgress} // Pass down the votingInProgress state
                  onVote={(action, team, msgId) => {
                    // CRITICAL FIX: Ensure pollId is passed as messageId when handling votes
                    // This improves poll association in the server responses
                    // Only handle the vote if voting isn't in progress
                    if (!votingInProgress) {
                      console.log(`🎮 MetaPoll vote handler: action=${action}, team=${team}, msgId=${msgId || 'none'}, pollId=${msg.pollId || 'none'}`);
                      handleMetaVote(action, team, msg.pollId || msgId);
                    } else {
                      console.log(`⚠️ Cannot handle vote: voting in progress`);
                    }
                  }}
                  key={`meta-poll-${getMessageId(msg)}`} // Add a unique key for better React rendering
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}