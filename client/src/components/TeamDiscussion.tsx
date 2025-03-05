import React, { useEffect, useState } from 'react';
import type { TeamDiscussionEntry, ConsensusVote } from '@shared/schema';

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
  suggestedWords?: string[];
  // Support legacy confidence field and new array
  confidences?: number[];
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

  // Debug: Log every time component receives props
  useEffect(() => {
    console.log('💬 TeamDiscussion received props:', {
      hasMessages: !!messages,
      messageCount: messages?.length,
      messageTypes: messages?.map(m => ({ type: m.type, team: m.team })),
      messages
    });
  }, [messages]);

  // Ensure messages is always an array
  const validMessages = messages || [];

  // WebSocket for real-time voting
  useEffect(() => {
    // Init state from messages prop
    const initFromMessages = () => {
      // Find messages with suggested words and populate wordVotes
      console.log('🔄 Initializing vote state from messages');
      
      // Process any votes already in the messages
      if (messages && Array.isArray(messages)) {
        const newWordVotes = {...wordVotes};
        const wordsWithSuggestions = new Set<string>();
        
        // Collect all suggested words
        messages.forEach(msg => {
          if (msg.suggestedWords && Array.isArray(msg.suggestedWords)) {
            msg.suggestedWords.forEach(word => wordsWithSuggestions.add(word));
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
        
        // Process word votes
        if (data.type === 'word_votes') {
          console.log('🗳️ Received word votes:', data);
          
          // Create a new object rather than mutating the existing one
          const newWordVotes = {...wordVotes};
          
          if (Array.isArray(data.words)) {
            data.words.forEach((wordData: any) => {
              if (wordData && wordData.word) {
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

  // Handle voting for a word
  const handleWordVote = async (word: string, team: string) => {
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

  // Handle voting for meta decisions (continue/end turn)
  const handleMetaVote = async (action: 'continue' | 'end_turn' | 'discuss_more', team: string) => {
    console.log(`🗳️ Submitting meta vote for action: "${action}" for team ${team}`);
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

  return (
    <div className="team-discussion" style={{
      maxHeight: '400px',
      overflowY: 'auto',
      padding: '10px',
      border: '1px solid #ccc',
      borderRadius: '4px',
      backgroundColor: '#fff',
      outline: '2px solid red'
    }}>
      {!validMessages.length && <div style={{ color: 'red', padding: '20px' }}>No messages yet</div>}
      {validMessages.map((msg, index) => {
        // Extract team for voting
        const team = msg.team;
        
        return (
          <div 
            key={`${msg.timestamp}-${msg.player}-${index}`}
            className={`message ${msg.team} ${msg.isVoting ? 'voting-message' : ''}`}
            style={{ 
              padding: '8px',
              margin: '4px',
              border: '2px solid',
              borderColor: msg.team === 'red' ? '#ff0000' : '#0000ff',
              backgroundColor: msg.isVoting ? (msg.team === 'red' ? '#fff8f8' : '#f8f8ff') : '#ffffff',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              boxShadow: msg.isVoting ? '0 0 8px rgba(0,0,0,0.1)' : 'none'
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
              <span>{msg.message}</span>
            </div>
            
            {/* Only display word suggestions section if there are suggested words */}
            {msg.suggestedWords && msg.suggestedWords.length > 0 ? (
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
                    
                    // Get voting data for this word
                    const voteData = wordVotes[word];
                    const hasVotes = voteData && voteData.votes > 0;
                    
                    return (
                      <div key={idx} style={{ 
                        marginBottom: '10px',
                        padding: '8px',
                        backgroundColor: idx === 0 ? 'rgba(240, 249, 255, 0.7)' : 'transparent',
                        borderRadius: '4px',
                        border: idx === 0 ? '1px solid #cce5ff' : 'none',
                        boxShadow: hasVotes && voteData.percentage > 50 ? '0 0 5px rgba(76, 175, 80, 0.5)' : 'none'
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
                            color: idx === 0 ? '#0066cc' : '#333'
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
                            Confidence: {Math.round(wordConfidence * 100)}%
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
                          <div style={{
                            display: 'flex',
                            gap: '4px',
                            fontSize: '0.85em'
                          }}>
                            <button 
                              onClick={() => handleWordVote(word, team)}
                              style={{
                                backgroundColor: '#f1f8e9',
                                border: '1px solid #c5e1a5',
                                borderRadius: '4px',
                                padding: '2px 8px',
                                cursor: 'pointer',
                                fontWeight: 'bold',
                                color: '#558b2f'
                              }}
                            >
                              Vote
                            </button>
                            <button 
                              onClick={() => console.log('Skipped voting for:', word)}
                              style={{
                                backgroundColor: '#ffebee',
                                border: '1px solid #ffcdd2',
                                borderRadius: '4px',
                                padding: '2px 8px',
                                cursor: 'pointer',
                                color: '#c62828'
                              }}
                            >
                              Skip
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
            
            {/* Display voting UI if agent is proposing a vote - Among Us style */}
            {msg.isVoting && (
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
                    backgroundColor: 'rgba(76, 175, 80, 0.1)',
                    borderRadius: '6px',
                    border: '1px solid rgba(76, 175, 80, 0.3)'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ fontSize: '1.2em', fontWeight: 'bold' }}>
                        {msg.voteType === 'end_turn' ? '👍 End Turn' : '👍 Continue'}
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
                    <button 
                      onClick={() => handleMetaVote(msg.voteType === 'end_turn' ? 'end_turn' : 'continue', team)}
                      style={{
                        backgroundColor: '#2e7d32',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        padding: '6px 10px',
                        fontWeight: 'bold',
                        cursor: 'pointer'
                      }}
                    >
                      Vote
                    </button>
                  </div>
                  
                  {/* Disagree Option */}
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 12px',
                    backgroundColor: 'rgba(244, 67, 54, 0.1)',
                    borderRadius: '6px',
                    border: '1px solid rgba(244, 67, 54, 0.3)'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ fontSize: '1.2em', fontWeight: 'bold' }}>
                        {msg.voteType === 'end_turn' ? '👎 Keep Going' : '👎 End Turn'}
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
                    <button 
                      onClick={() => handleMetaVote(msg.voteType === 'end_turn' ? 'continue' : 'end_turn', team)}
                      style={{
                        backgroundColor: '#c62828',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        padding: '6px 10px',
                        fontWeight: 'bold',
                        cursor: 'pointer'
                      }}
                    >
                      Vote
                    </button>
                  </div>
                  
                  {/* Discuss More Option */}
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 12px',
                    backgroundColor: 'rgba(255, 152, 0, 0.1)',
                    borderRadius: '6px',
                    border: '1px solid rgba(255, 152, 0, 0.3)'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ fontSize: '1.2em', fontWeight: 'bold' }}>
                        🤔 Discuss More
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
                    <button 
                      onClick={() => handleMetaVote('discuss_more', team)}
                      style={{
                        backgroundColor: '#f57c00',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        padding: '6px 10px',
                        fontWeight: 'bold',
                        cursor: 'pointer'
                      }}
                    >
                      Vote
                    </button>
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