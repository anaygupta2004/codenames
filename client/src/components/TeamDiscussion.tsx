import React, { useEffect } from 'react';
import type { TeamDiscussionEntry } from '@shared/schema';

interface TeamDiscussionProps {
  messages: TeamDiscussionEntry[];
}

export function TeamDiscussion({ messages }: TeamDiscussionProps) {
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

  console.log('💭 TeamDiscussion render:', {
    messageCount: messages?.length,
    firstMessage: messages?.[0],
    lastMessage: messages?.[messages.length - 1]
  });

  // Ensure messages is always an array
  const validMessages = messages || [];

  // Debug: Log what we're about to render
  console.log('💬 TEAMDISCUSSION RENDERING:', {
    validMessageCount: validMessages.length,
    messages: validMessages
  });

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
      {console.log('�� TEAMDISCUSSION JSX:', {
        isRendering: true,
        messageCount: validMessages.length
      })}
      {!validMessages.length && <div style={{ color: 'red', padding: '20px' }}>No messages yet</div>}
      {validMessages.map((msg, index) => {
        console.log(`💬 Rendering message ${index}:`, msg);
        return (
          <div 
            key={`${msg.timestamp}-${msg.player}-${index}`}  // Better unique key
            className={`message ${msg.team}`}
            style={{ 
              padding: '8px',
              margin: '4px',
              border: '2px solid',  // Make messages more visible
              borderColor: msg.team === 'red' ? '#ff0000' : '#0000ff',
              backgroundColor: '#ffffff',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px'
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
            {msg.suggestedWord && (
              <div style={{
                marginTop: '4px',
                fontSize: '0.9em',
                fontStyle: 'italic',
                color: '#666'
              }}>
                Suggests: {msg.suggestedWord} ({Math.round(msg.confidence * 100)}% confident)
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
} 