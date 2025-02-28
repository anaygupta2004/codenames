import React, { useRef, useEffect } from 'react';

const useGame = () => {
  // Use a persistent client ID from localStorage
  const clientId = useRef(localStorage.getItem('clientId') || (() => {
    const newId = Math.random().toString(36).substring(7);
    localStorage.setItem('clientId', newId);
    return newId;
  })());

  const wsRef = useRef(null);

  useEffect(() => {
    // Prevent creating a new connection if one is already open
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    // Clean up any existing connection if not open
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  wsRef.current?.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    if (data.type === 'reset') {
      // Clear local storage and close connection
      localStorage.removeItem('clientId');
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      // Generate new client ID for future.
      clientId.current = Math.random().toString(36).substring(7);
      localStorage.setItem('clientId', clientId.current);
      return;
    }
  };

  return { clientId };
};

export default useGame; 