
import { useState, useEffect } from "react"
import type { MetaVote } from "@shared/schema"
import { SiAnthropic, SiGooglecloud, SiOpenai, SiX } from "react-icons/si"
import { motion } from "framer-motion"

interface MetaPollProps {
  pollId: string
  team: "red" | "blue"
  gameId: number
  timestamp: number
  messageId?: string
  onVote?: (action: "continue" | "end_turn" | "discuss_more", team: string, messageId?: string) => void
  currentClue?: { word: string; number: number }
  gameScore?: { red: number; blue: number }
}

// Helper function to get icons for different AI models
const getModelIcon = (model: string) => {
  // Extract base model name from any format
  let baseModel = model

  if (typeof model === "string") {
    if (model.includes("#")) {
      baseModel = model.split("#")[0]
    } else if (model.includes("-")) {
      const parts = model.split("-")
      if (["gpt-4o", "claude-3-5-sonnet-20241022", "grok-2-1212", "gemini-1.5-pro", "llama-7b"].includes(parts[0])) {
        baseModel = parts[0]
      }
    }
  }

  if (baseModel === "gpt-4o") return <SiOpenai />
  if (baseModel === "claude-3-5-sonnet-20241022") return <SiAnthropic />
  if (baseModel === "grok-2-1212") return <SiX />
  if (baseModel === "gemini-1.5-pro") return <SiGooglecloud />

  if (baseModel === "human") return "👤"
  if (baseModel === "Game") return "🎮"

  return "🤖"
}

export function MetaPoll({ pollId, team, gameId, timestamp, messageId, onVote }: MetaPollProps) {
  const [votes, setVotes] = useState<{
    continue: { count: number; voters: { player: string; uniqueId?: string; reasoning?: string }[] }
    end_turn: { count: number; voters: { player: string; uniqueId?: string; reasoning?: string }[] }
    error?: string
  }>({
    continue: { count: 0, voters: [] },
    end_turn: { count: 0, voters: [] }
  })

  const [animateIn, setAnimateIn] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setAnimateIn(true), 100)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    const fetchVotes = async () => {
      try {
        const res = await fetch(`/api/games/${gameId}`)
        if (!res.ok) return

        const game = await res.json()

        const isRedTeam = team === "red"
        const teamSpymaster = isRedTeam ? game.redSpymaster : game.blueSpymaster

        const newVotes = {
          continue: { count: 0, voters: [] as { player: string; uniqueId?: string; reasoning?: string }[] },
          end_turn: { count: 0, voters: [] as { player: string; uniqueId?: string; reasoning?: string }[] },
        }

        const messageIdMatch = pollId.match(/meta-\w+-(\d+)/)
        const messageTimestamp = messageIdMatch ? messageIdMatch[1] : ""
        
        // Check if this poll ID has been marked as a duplicate
        const voteDeduplicationMap = JSON.parse(localStorage.getItem('pollIdDeduplicationMap') || '{}');
        const possibleDuplicate = voteDeduplicationMap[pollId];
        
        // CRITICAL FIX: Check the message ID map to find related polls
        const pollMessageMap = JSON.parse(localStorage.getItem('pollMessageIdMap') || '{}');
        const pollsWithSameMessage = Object.entries(pollMessageMap)
          .filter(([_pollId, msgId]) => msgId === messageId)
          .map(([pollId]) => pollId);
          
        console.log(`🔍 Found ${pollsWithSameMessage.length} polls with messageId ${messageId}:`, pollsWithSameMessage);
        
        // If this poll is marked as a duplicate, use the canonical poll ID instead
        const effectivePollId = possibleDuplicate || pollId;
        
        console.log(`📊 MetaPoll ${pollId} - Checking for votes (effective ID: ${effectivePollId}, messageId: ${messageId})`);
        console.log(`Total available votes: ${game.metaVotes?.length || 0}`);
        // Log all available meta votes for debugging
        if (game.metaVotes && game.metaVotes.length > 0) {
          game.metaVotes.forEach((v: MetaVote, i: number) => {
            console.log(`Vote ${i}: pollId=${v.pollId}, team=${v.team}, player=${v.player}, messageId=${v.messageId || 'none'}`);
          });
        }

        // FIXED: Make vote matching more permissive to ensure all valid votes are displayed
        const teamVotes = (game.metaVotes || []).filter((v: MetaVote) => {
          // First make sure this vote belongs to the right team
          if (v.team !== team) {
            // Skip votes from other teams
            return false
          }

          // Skip votes from spymaster
          if (v.player === teamSpymaster || (typeof v.player === "string" && v.player.startsWith(teamSpymaster))) {
            return false
          }

          // Skip system-created placeholder votes
          if (v.player === "Game" || (typeof v.player === "string" && v.player.startsWith("Game#"))) {
            // Only filter out Game votes with low confidence (placeholder votes)
            if (v.confidence && v.confidence < 0.1) {
              return false
            }
          }

          // For debugging - log the vote we're checking with more detail
          console.log(`📊 Vote check: poll=${v.pollId} vs ${pollId}, msg=${v.messageId} vs ${messageId}, confidence=${v.confidence}`)
          
          // CRITICAL FIX: Be more permissive in vote matching to ensure they display properly
          // First check for exact pollId match (most reliable)
          if (v.pollId === pollId || v.pollId === effectivePollId) {
            console.log(`✅ Poll ID exact match: ${v.pollId}`)
            return true
          }
          
          // Check if vote's pollId matches any related polls with same messageId
          if (pollsWithSameMessage.includes(v.pollId)) {
            console.log(`✅ Related poll match found: ${v.pollId} via messageId map`)
            return true
          }
          
          // Check for messageId match (reliable backup)
          if (messageId && v.messageId === messageId) {
            console.log(`✅ MessageID exact match: ${messageId}`)
            return true
          }
          
          // Check for partial pollId match when both include the same action
          if (v.action && typeof v.pollId === 'string' && typeof pollId === 'string') {
            // Check for patterns like meta-red-12345-continue or meta-blue-12345-end_turn
            const actionMatch = v.pollId.includes(`-${v.action}`) && pollId.includes(`-${v.action}`)
            if (actionMatch) {
              console.log(`✅ Action match in poll ID: ${v.action}`)
              return true
            }
          }
          
          // ENHANCED: More flexible matching based on timestamps with wider windows for compatibility
          if (typeof v.pollId === 'string' && typeof pollId === 'string') {
            // Extract timestamp from poll IDs if they follow meta-team-timestamp pattern
            const pollTimestamp = pollId.match(/meta-\w+-(\d+)/)?.[1]
            const voteTimestamp = v.pollId.match(/meta-\w+-(\d+)/)?.[1]
            
            // If both have timestamps and they're within 10 seconds of each other, consider them the same poll
            // Increased window size to catch more related votes
            if (pollTimestamp && voteTimestamp && 
                Math.abs(parseInt(pollTimestamp) - parseInt(voteTimestamp)) < 10000 &&
                v.team === team) {
              // Store this match in localStorage for future reference
              try {
                const dedupeMap = JSON.parse(localStorage.getItem('pollIdDeduplicationMap') || '{}')
                dedupeMap[v.pollId] = pollId
                localStorage.setItem('pollIdDeduplicationMap', JSON.stringify(dedupeMap))
                console.log(`✅ Timestamp match found: ${pollTimestamp} - ${voteTimestamp} (within 10s window)`)
              } catch (e) {}
              return true
            }
          }
          
          // CRITICAL FIX: Last resort - if this vote is for the same team and has the right action,
          // include it in this poll for better visibility
          if (v.team === team && v.action && v.confidence > 0.5) {
            // Check if the pollId looks like the right format (contains team name)
            const teamInPollId = (typeof pollId === 'string' && pollId.includes(`-${team}-`));
            const teamInVotePollId = (typeof v.pollId === 'string' && v.pollId.includes(`-${team}-`));
            
            if (teamInPollId && teamInVotePollId) {
              console.log(`✅ Last resort match: high confidence vote from ${v.player} for team ${team}`)
              return true
            }
          }
          
          // SUPER PERMISSIVE: Include ALL votes for this team with matching action since last turn
          // This dramatically increases the chance of showing votes
          if (v.team === team && v.action) {
            // Only for recent votes (within last 60 seconds)
            const isRecentVote = v.timestamp && (Date.now() - v.timestamp < 60000);
            if (isRecentVote) {
              console.log(`✅ Recent team vote match: ${v.player} for team ${team}`);
              return true;
            }
          }

          return false
        })

        teamVotes.forEach((vote: MetaVote) => {
          if (!vote.action) return

          let uniqueId = ""
          if (typeof vote.player === "string" && vote.player.includes("#")) {
            uniqueId = vote.player.split("#")[1]
          }

          if (newVotes[vote.action]) {
            newVotes[vote.action].count++
            newVotes[vote.action].voters.push({
              player: vote.player,
              uniqueId,
              reasoning: vote.reasoning,
            })
            
            // Log that we added a vote for better debugging
            console.log(`➕ Added vote from ${vote.player} for ${vote.action} (${newVotes[vote.action].count} total)`)
          } else {
            console.log(`⚠️ Skipping vote with invalid action: ${vote.action}`)
          }
        })

        setVotes(newVotes)
      } catch (error) {
        console.error("Error fetching poll votes:", error)
      }
    }

    fetchVotes()

    // Increase refresh rate for more responsive updates
    const intervalId = setInterval(fetchVotes, 1000)
    return () => clearInterval(intervalId)
  }, [pollId, team, gameId, messageId])

  const handleVote = async (action: "continue" | "end_turn" | "discuss_more") => {
    if (onVote) {
      onVote(action, team, messageId)
      return
    }
    
    // Rate limiting: prevent multiple votes in quick succession
    const lastVoteTime = parseInt(localStorage.getItem(`lastMetaVoteTime-${team}`) || '0')
    const now = Date.now()
    const VOTE_COOLDOWN = 3000 // 3 seconds between votes
    
    if (now - lastVoteTime < VOTE_COOLDOWN) {
      console.log(`⚠️ Vote throttled - please wait before voting again`)
      // Set error state
      setVotes(prev => ({
        ...prev,
        error: "Please wait a moment before voting again"
      }))
      return
    }
    
    // Update last vote time
    localStorage.setItem(`lastMetaVoteTime-${team}`, now.toString())

    // Generate a unique ID for this human vote to prevent duplicates
    // Don't reuse IDs across different votes from the same human
    const uniqueId = `human-${Math.floor(1000000000 + Math.random() * 9000000000)}`
    
    // CRITICAL FIX: Use the original poll ID exactly as provided
    // This ensures votes belong to the correct poll and prevents poll unification
    const effectivePollId = pollId
    
    // Store a mapping in localStorage to track the relationship between pollId and messageId
    // This helps ensure that votes are properly associated with polls in the UI
    try {
      const pollMessageMap = JSON.parse(localStorage.getItem('pollMessageIdMap') || '{}');
      pollMessageMap[effectivePollId] = messageId || effectivePollId;
      localStorage.setItem('pollMessageIdMap', JSON.stringify(pollMessageMap));
      console.log(`📝 Stored poll-message mapping: ${effectivePollId} → ${messageId || effectivePollId}`);
    } catch (e) {
      console.error("Error storing poll-message mapping:", e);
    }
    
    console.log(`🔑 Submitting human vote with: pollId=${effectivePollId}, messageId=${messageId}, uniqueId=${uniqueId.substring(0, 10)}...`)

    // CRITICAL: First check if this is the user's team before allowing vote
    // Get current team from localStorage first
    const currentUserTeam = localStorage.getItem('selectedTeam');
    
    // Only allow voting if user is on this specific team
    if (currentUserTeam !== team) {
      console.error(`⛔️ Cannot vote - you are on ${currentUserTeam || 'no'} team but this poll is for ${team} team`);
      setVotes(prev => ({
        ...prev,
        error: `You can only vote on your own team's decisions`
      }));
      return;
    }
    
    console.log(`✅ Submitting vote for ${action} from team ${team}`);
    
    try {
      console.log(`🗳️ Submitting meta vote with pollId=${effectivePollId}, messageId=${messageId}`)
      await fetch(`/api/games/${gameId}/meta/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `human#${uniqueId}`,
          team,
          action,
          pollId: effectivePollId, // Use original poll ID to ensure votes are counted together
          messageId, // CRITICAL: Include messageId for proper poll association
          reasoning: `Human player voted to ${
            action === "continue" ? "continue guessing because they think there are more words to find" : 
            action === "end_turn" ? "end the turn because they think it's too risky to continue" : 
            "discuss more before deciding"
          }`,
        }),
      })

      // Immediately update the UI for a better user experience
      setVotes((prev) => {
        const newAction = { ...prev[action] }

        newAction.count++
        newAction.voters.push({
          player: `human#${uniqueId}`,
          uniqueId,
          reasoning: `Human player voted to ${
            action === "continue" ? "continue guessing" : action === "end_turn" ? "end the turn" : "discuss more"
          }`,
        })

        return {
          ...prev,
          [action]: newAction,
        }
      })
      
      // Force another data refresh after a short delay
      setTimeout(() => {
        fetch(`/api/games/${gameId}`)
          .then(res => res.json())
          .catch(err => console.error("Error refreshing game after vote:", err));
      }, 300);
    } catch (error) {
      console.error("Error submitting vote:", error)
    }
  }

  const [operativesCount, setOperativesCount] = useState(2)

  useEffect(() => {
    if (gameId) {
      fetch(`/api/games/${gameId}`)
        .then((res) => res.json())
        .then((game) => {
          const teamSpymaster = team === "red" ? game.redSpymaster : game.blueSpymaster
          const teamPlayers = team === "red" ? game.redPlayers : game.bluePlayers
          const operatives = teamPlayers.filter((p) => p !== teamSpymaster).length
          setOperativesCount(Math.max(1, operatives))
        })
        .catch((err) => console.error("Error fetching team count:", err))
    }
  }, [gameId, team])

  const totalVotes = votes.continue.count + votes.end_turn.count
  const continuePercentage = totalVotes ? Math.round((votes.continue.count / totalVotes) * 100) : 0
  const endTurnPercentage = totalVotes ? Math.round((votes.end_turn.count / totalVotes) * 100) : 0

  const winningAction = totalVotes ? (votes.continue.count >= votes.end_turn.count ? "continue" : "end_turn") : null

  return (
    <motion.div
      className="meta-poll w-full"
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={
        animateIn
          ? {
              opacity: 1,
              y: 0,
              scale: 1,
              transition: {
                type: "spring",
                stiffness: 300,
                damping: 20,
              },
            }
          : {}
      }
      style={{
        padding: "12px",
        marginTop: "8px",
        marginBottom: "8px",
        backgroundColor: "white",
        border: "1px solid rgba(229, 231, 235, 0.3)",
        borderRadius: "8px",
        boxShadow: "0 2px 6px rgba(0, 0, 0, 0.02)",
      }}
    >
      {/* Display error message if any */}
      {votes.error && (
        <div 
          style={{
            padding: "8px",
            marginBottom: "12px",
            backgroundColor: "rgba(254, 226, 226, 0.8)",
            color: "#b91c1c",
            borderRadius: "6px",
            fontSize: "0.9em",
            fontWeight: "500",
            textAlign: "center",
            border: "1px solid rgba(220, 38, 38, 0.3)"
          }}
        >
          {votes.error}
        </div>
      )}
      {/* Continue Option */}
      <div
        onClick={() => handleVote("continue")}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px",
          backgroundColor: "white",
          borderRadius: "8px",
          marginBottom: "10px",
          border: "1px solid rgba(34, 197, 94, 0.3)",
          transition: "all 0.3s ease",
          cursor: "pointer",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Fill bar */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            height: "100%",
            width: `${continuePercentage}%`,
            backgroundColor: "rgba(34, 197, 94, 0.12)",
            transition: "width 0.8s ease",
          }}
        />

        {/* Content (positioned above the fill) */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", position: "relative", zIndex: 1 }}>
          <span style={{ fontSize: "1em", color: "rgba(22, 163, 74, 0.75)" }}>Continue</span>
          <div style={{ display: "flex", marginLeft: "4px" }}>
            {votes.continue.voters.map((voter, idx) => (
              <motion.div
                key={idx}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.3 + idx * 0.1 }}
                style={{ position: "relative", margin: "-2px" }}
                className="voter-container"
              >
                <div
                  title={voter.player + (voter.reasoning ? `: ${voter.reasoning}` : "")}
                  style={{
                    padding: "2px",
                    backgroundColor: "rgba(209, 250, 229, 0.8)",
                    borderRadius: "50%",
                    border: "1px solid white",
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: "24px",
                    height: "24px",
                    fontSize: "0.75rem",
                    color: "#047857",
                  }}
                >
                  {getModelIcon(voter.player)}
                  {typeof voter.player === "string" && voter.player.includes("#") && (
                    <span
                      style={{
                        position: "absolute",
                        top: "-3px",
                        right: "-3px",
                        fontSize: "0.5em",
                        backgroundColor: "#f0f0f0",
                        padding: "1px 2px",
                        borderRadius: "6px",
                        color: "#666",
                        border: "1px solid #ddd",
                      }}
                    >
                      {voter.player.split("#")[1].substring(0, 3)}
                    </span>
                  )}
                </div>
                {voter.reasoning && (
                  <div
                    className="reasoning-tooltip"
                    style={{
                      position: "absolute",
                      bottom: "-35px",
                      left: "50%",
                      transform: "translateX(-50%)",
                      fontSize: "0.75em",
                      color: "#333",
                      backgroundColor: "white",
                      border: "1px solid #e5e7eb",
                      borderRadius: "6px",
                      padding: "4px 8px",
                      maxWidth: "180px",
                      opacity: 0,
                      transition: "opacity 0.2s",
                      pointerEvents: "none",
                      zIndex: 20,
                      boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
                    }}
                  >
                    {voter.reasoning}
                  </div>
                )}
              </motion.div>
            ))}
          </div>
        </div>
        {votes.continue.count > 0 && (
          <span
            style={{
              fontSize: "0.85em",
              color: "rgba(22, 163, 74, 0.75)",
              position: "relative",
              zIndex: 1,
            }}
          >
            {continuePercentage}%
          </span>
        )}
      </div>

      {/* End Turn Option */}
      <div
        onClick={() => handleVote("end_turn")}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px",
          backgroundColor: "white",
          borderRadius: "8px",
          marginBottom: "12px",
          border: "1px solid rgba(239, 68, 68, 0.3)",
          transition: "all 0.3s ease",
          cursor: "pointer",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Fill bar */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            height: "100%",
            width: `${endTurnPercentage}%`,
            backgroundColor: "rgba(239, 68, 68, 0.12)",
            transition: "width 0.8s ease",
          }}
        />

        {/* Content (positioned above the fill) */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", position: "relative", zIndex: 1 }}>
          <span style={{ fontSize: "1em", color: "rgba(220, 38, 38, 0.75)" }}>End Turn</span>
          <div style={{ display: "flex", marginLeft: "4px" }}>
            {votes.end_turn.voters.map((voter, idx) => (
              <motion.div
                key={idx}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.3 + idx * 0.1 }}
                style={{ position: "relative", margin: "-2px" }}
                className="voter-container"
              >
                <div
                  title={voter.player + (voter.reasoning ? `: ${voter.reasoning}` : "")}
                  style={{
                    padding: "2px",
                    backgroundColor: "rgba(254, 226, 226, 0.8)",
                    borderRadius: "50%",
                    border: "1px solid white",
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: "24px",
                    height: "24px",
                    fontSize: "0.75rem",
                    color: "#b91c1c",
                  }}
                >
                  {getModelIcon(voter.player)}
                  {typeof voter.player === "string" && voter.player.includes("#") && (
                    <span
                      style={{
                        position: "absolute",
                        top: "-3px",
                        right: "-3px",
                        fontSize: "0.5em",
                        backgroundColor: "#f0f0f0",
                        padding: "1px 2px",
                        borderRadius: "6px",
                        color: "#666",
                        border: "1px solid #ddd",
                      }}
                    >
                      {voter.player.split("#")[1].substring(0, 3)}
                    </span>
                  )}
                </div>
                {voter.reasoning && (
                  <div
                    className="reasoning-tooltip"
                    style={{
                      position: "absolute",
                      bottom: "-35px",
                      left: "50%",
                      transform: "translateX(-50%)",
                      fontSize: "0.75em",
                      color: "#333",
                      backgroundColor: "white",
                      border: "1px solid #e5e7eb",
                      borderRadius: "6px",
                      padding: "4px 8px",
                      maxWidth: "180px",
                      opacity: 0,
                      transition: "opacity 0.2s",
                      pointerEvents: "none",
                      zIndex: 20,
                      boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
                    }}
                  >
                    {voter.reasoning}
                  </div>
                )}
              </motion.div>
            ))}
          </div>
        </div>
        {votes.end_turn.count > 0 && (
          <span
            style={{
              fontSize: "0.85em",
              color: "rgba(220, 38, 38, 0.75)",
              position: "relative",
              zIndex: 1,
            }}
          >
            {endTurnPercentage}%
          </span>
        )}
      </div>

      {/* Progress Bar - more transparent */}
      <div
        className="progress-container"
        style={{
          height: "6px",
          backgroundColor: "rgba(243, 244, 246, 0.2)",
          borderRadius: "3px",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <motion.div
          initial={{ width: "0%" }}
          animate={{ width: `${continuePercentage}%` }}
          transition={{ duration: 0.8, ease: [0.34, 1.56, 0.64, 1] }}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            height: "100%",
            backgroundColor: "rgba(34, 197, 94, 0.3)",
            borderRadius: "3px 0 0 3px",
          }}
        />
        <motion.div
          initial={{ width: "0%" }}
          animate={{ width: `${endTurnPercentage}%` }}
          transition={{ duration: 0.8, ease: [0.34, 1.56, 0.64, 1] }}
          style={{
            position: "absolute",
            right: 0,
            top: 0,
            height: "100%",
            backgroundColor: "rgba(239, 68, 68, 0.3)",
            borderRadius: "0 3px 3px 0",
          }}
        />
      </div>
    </motion.div>
  )
}

export default MetaPoll
