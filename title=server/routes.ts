          if (data.type === 'join') {
            // Check if this client already has a connection
            const existingWs = activeClients.get(data.clientId);
            if (existingWs && existingWs !== ws) {
              // Close the existing connection
              existingWs.close();
              activeClients.delete(data.clientId);

              // Clean it up from the connections map
              if (connections.has(existingWs)) {
                const oldConn = connections.get(existingWs)!;
                const oldGameRoom = gameDiscussions.get(oldConn.gameId);
                if (oldGameRoom) {
                  oldGameRoom.clients.delete(existingWs);
                }
                connections.delete(existingWs);
              }
            }

            // Enforce a COOLDOWN_MS period before allowing a new join from the same client
            const lastConnectionTime = clientConnectionTimes.get(data.clientId);
            const now = Date.now();
            if (lastConnectionTime && now - lastConnectionTime < RATE_LIMIT.COOLDOWN_MS) {
              ws.close();
              return;
            }
            clientConnectionTimes.set(data.clientId, now);
          } 