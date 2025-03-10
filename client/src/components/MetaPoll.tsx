
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
  onVotingStatusChange?: (isVoting: boolean) => void
  teamOperativeCount?: number
  votingInProgress?: boolean // Add prop to accept votingInProgress from parent
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

// Type for vote actions to properly handle the TypeScript errors
type VoteAction = "continue" | "end_turn" | "discuss_more";

// Define the votes state type to fix TypeScript errors
interface VotesState {
  continue: { count: number; voters: { player: string; uniqueId?: string; reasoning?: string }[] };
  end_turn: { count: number; voters: { player: string; uniqueId?: string; reasoning?: string }[] };
  discuss_more?: { count: number; voters: { player: string; uniqueId?: string; reasoning?: string }[] };
  error?: string;
}

export function MetaPoll({ pollId, team, gameId, timestamp, messageId, onVote, onVotingStatusChange, teamOperativeCount = 0, votingInProgress: parentVotingInProgress }: MetaPollProps) {
  // Initialize the votes state with proper typing
  const [votes, setVotes] = useState<VotesState>({
    continue: { count: 0, voters: [] },
    end_turn: { count: 0, voters: [] },
    discuss_more: { count: 0, voters: [] }
  })
  
  // Track if all operatives have voted
  const [allOperativesVoted, setAllOperativesVoted] = useState(false)
  
  // Track if voting is in progress to disable discussion
  // Use the parent's votingInProgress state if provided, otherwise use component's local state
  const [internalVotingInProgress, setInternalVotingInProgress] = useState(true)
  
  // Use either the parent's votingInProgress state (if provided) or the internal state
  const votingInProgress = parentVotingInProgress !== undefined ? parentVotingInProgress : internalVotingInProgress
  
  // Notify parent component about voting status changes
  useEffect(() => {
    if (onVotingStatusChange) {
      onVotingStatusChange(internalVotingInProgress)
    }
  }, [internalVotingInProgress, onVotingStatusChange])

  const [animateIn, setAnimateIn] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setAnimateIn(true), 100)
    return () => clearTimeout(timer)
  }, [])

  // Function to deduplicate polls based on messageId to fix the multiple polls issue
  useEffect(() => {
    // This runs once when the component mounts
    // It helps consolidate any duplicate polls with the same messageId
    if (messageId) {
      const pollMessageMap = JSON.parse(localStorage.getItem('pollMessageIdMap') || '{}');
      const canonicalPollId = Object.entries(pollMessageMap)
        .find(([_pollId, msgId]) => msgId === messageId)?.[0];
      
      if (canonicalPollId && canonicalPollId !== pollId) {
        console.log(`⚠️ Duplicate poll detected! ${pollId} will be redirected to ${canonicalPollId}`)
        // Mark this poll as a duplicate and map it to the canonical one
        const dedupeMap = JSON.parse(localStorage.getItem('pollIdDeduplicationMap') || '{}');
        dedupeMap[pollId] = canonicalPollId;
        localStorage.setItem('pollIdDeduplicationMap', JSON.stringify(dedupeMap));
      } else if (!canonicalPollId) {
        // This is the first poll with this messageId, register it as canonical
        pollMessageMap[pollId] = messageId;
        localStorage.setItem('pollMessageIdMap', JSON.stringify(pollMessageMap));
        console.log(`📝 Registered canonical poll: ${pollId} for messageId ${messageId}`)
      }
    }
    
    // IMPORTANT: When a MetaPoll is created, signal that voting is in progress
    // This will be used to disable discussion during voting
    if (onVotingStatusChange) {
      onVotingStatusChange(true);
    }
    
    // When component unmounts, signal that voting is no longer in progress
    return () => {
      if (onVotingStatusChange) {
        onVotingStatusChange(false);
      }
    };
  }, [pollId, messageId, onVotingStatusChange]);

  useEffect(() => {
    const fetchVotes = async () => {
      try {
        const res = await fetch(`/api/games/${gameId}`)
        if (!res.ok) return

        const game = await res.json()

        const isRedTeam = team === "red"
        const teamSpymaster = isRedTeam ? game.redSpymaster : game.blueSpymaster

        // Fix TypeScript error by properly typing the newVotes object
        const newVotes: VotesState = {
          continue: { count: 0, voters: [] },
          end_turn: { count: 0, voters: [] },
          discuss_more: { count: 0, voters: [] }
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

        // Calculate total unique human voters (operatives)
        const humanVoterIds = new Set();
        [...newVotes.continue.voters, ...newVotes.end_turn.voters]
          .filter(voter => typeof voter.player === 'string' && voter.player.startsWith('human#'))
          .forEach(voter => {
            if (voter.uniqueId) {
              humanVoterIds.add(voter.uniqueId);
            }
          });
          
        const humanVoteCount = humanVoterIds.size;
        
        // Get operative count from prop or localStorage
        let operativeCount = teamOperativeCount;
        if (!operativeCount) {
          // Try to estimate number of operatives from local storage records
          const teamIds = Object.keys(localStorage)
            .filter(key => key.startsWith(`${team}-operative-id`) || key === `${team}-operative-id`);
          
          operativeCount = Math.max(teamIds.length, 2); // Assume at least 2 operatives
        }
        
        console.log(`🧮 Human votes: ${humanVoteCount}/${operativeCount} operatives have voted`);
        
        // Check if all operatives have voted
        const allVoted = humanVoteCount >= operativeCount;
        setAllOperativesVoted(allVoted);
        
        // If all operatives have voted, signal to disable voting after a delay
        if (allVoted && onVotingStatusChange) {
          // After a short delay, signal that voting has concluded
          setTimeout(() => {
            setInternalVotingInProgress(false);
            onVotingStatusChange(false);
          }, 2000); // Give people time to see the final result
        }
        
        setVotes(newVotes)
      } catch (error) {
        console.error("Error fetching poll votes:", error)
      }
    }

    fetchVotes()

    // Increase refresh rate for more responsive updates
    const intervalId = setInterval(fetchVotes, 1000)
    return () => clearInterval(intervalId)
  }, [pollId, team, gameId, messageId, teamOperativeCount, onVotingStatusChange])

  const handleVote = async (action: VoteAction) => {
    // Don't allow voting if voting is in progress from parent component
    if (votingInProgress) {
      console.log(`⚠️ Cannot vote while voting is in progress`);
      setVotes(prev => ({
        ...prev,
        error: "Voting is currently in progress. Please wait..."
      }));
      return;
    }
    
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

    // Get or create a persistent unique 5-digit ID for this team operative
    // This ID will be used consistently for all votes from this operative
    let operativeUniqueId = localStorage.getItem(`${team}-operative-id`)
    
    // If no ID exists yet, create a new 5-digit ID and store it
    if (!operativeUniqueId) {
      // Generate a 5-digit ID between 10000 and 99999
      operativeUniqueId = Math.floor(10000 + Math.random() * 90000).toString()
      localStorage.setItem(`${team}-operative-id`, operativeUniqueId)
      console.log(`🆔 Created new team operative ID: ${operativeUniqueId}`)
    }
    
    // Use this ID to prevent double voting
    const uniqueId = `operative-${operativeUniqueId}`
    
    // Check if this operative already voted on this poll
    const operativeVoteKey = `voted-${team}-${pollId}-${operativeUniqueId}`
    if (localStorage.getItem(operativeVoteKey)) {
      console.log(`⛔ Operative ${operativeUniqueId} already voted on this poll`)
      setVotes(prev => ({
        ...prev,
        error: "You have already voted on this decision"
      }))
      return
    }
    
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
      
      // Mark this operative as having voted on this poll
      localStorage.setItem(`voted-${team}-${pollId}-${operativeUniqueId}`, 'true')

      // Immediately update the UI for a better user experience
      setVotes((prev) => {
        // Fix TypeScript error with action indexing by performing a type check
        if (action === "continue" || action === "end_turn" || action === "discuss_more") {
          // Create a safe copy with the right typing
          const actionData = prev[action] || { count: 0, voters: [] };
          const newAction = { ...actionData };
          
          newAction.count++;
          newAction.voters.push({
            player: `human#${uniqueId}`,
            uniqueId,
            reasoning: `Human player voted to ${
              action === "continue" ? "continue guessing" : action === "end_turn" ? "end the turn" : "discuss more"
            }`,
          });
          
          return {
            ...prev,
            [action]: newAction,
          };
        }
        return prev;
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
          // Fix TypeScript 'any' type error by properly typing the parameter
          const operatives = teamPlayers.filter((p: string) => p !== teamSpymaster).length
          setOperativesCount(Math.max(1, operatives))
        })
        .catch((err) => console.error("Error fetching team count:", err))
    }
  }, [gameId, team])

  const totalVotes = votes.continue.count + votes.end_turn.count
  const continuePercentage = totalVotes ? Math.round((votes.continue.count / totalVotes) * 100) : 0
  const endTurnPercentage = totalVotes ? Math.round((votes.end_turn.count / totalVotes) * 100) : 0

  const winningAction = totalVotes ? (votes.continue.count >= votes.end_turn.count ? "continue" : "end_turn") : null
  
  // Determine if the vote is unanimous (all operatives voted the same way)
  const isUnanimous = (continuePercentage === 100 || endTurnPercentage === 100) && totalVotes >= operativesCount
  
  // If all operatives have voted and the vote is decisive (80%+ in one direction), simplify the UI
  const shouldShowSimplifiedUI = (totalVotes >= operativesCount) && 
    (continuePercentage >= 80 || endTurnPercentage >= 80)
    
  // CRITICAL FIX: Handle turn ending when team votes to end turn
  useEffect(() => {
    // Only execute if we have sufficient votes and a winning action
    if (totalVotes >= operativesCount && winningAction && shouldShowSimplifiedUI) {
      console.log(`🔄 Meta poll completed with decision: ${winningAction}`)
      
      // If vote is to end turn, notify parent component to handle turn change
      if (winningAction === "end_turn") {
        console.log(`🛑 Team voted to END TURN - initiating turn change`)
        
        // Notify game component that voting is complete and turn should end
        if (onVotingStatusChange) {
          onVotingStatusChange(false)
          setInternalVotingInProgress(false)
        }
        
        // Explicit API call to end the turn
        try {
          fetch(`/api/games/${gameId}/meta/turn`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "end_turn",
              team,
              pollId
            })
          })
          
          // Also make an explicit call to the onVote handler
          if (onVote) {
            onVote("end_turn", team, messageId)
          }
          
          // Force an explicit turn change in the local storage state
          // so that the game component will immediately see and act on it
          localStorage.setItem(`meta-result-${pollId}`, JSON.stringify({
            action: "end_turn",
            team,
            timestamp: Date.now(),
            complete: true
          }))
          
        } catch (err) {
          console.error("Error ending turn after meta vote:", err)
        }
      } else if (winningAction === "continue") {
        // If vote is to continue, just notify parent voting is complete
        console.log(`✅ Team voted to CONTINUE guessing`)
        if (onVotingStatusChange) {
          onVotingStatusChange(false)
          setInternalVotingInProgress(false)
        }
        
        // Also make an explicit call to the onVote handler
        if (onVote) {
          onVote("continue", team, messageId)
        }
        
        // Force an explicit continue state in local storage
        localStorage.setItem(`meta-result-${pollId}`, JSON.stringify({
          action: "continue",
          team,
          timestamp: Date.now(),
          complete: true
        }))
      }
    }
  }, [totalVotes, operativesCount, winningAction, shouldShowSimplifiedUI, gameId, team, pollId, onVotingStatusChange, onVote, messageId])

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
      {/* When vote is unanimous or decisive, show a simplified message */}
      {shouldShowSimplifiedUI ? (
        <div
          style={{
            padding: "15px",
            backgroundColor: winningAction === "continue" ? "rgba(209, 250, 229, 0.8)" : "rgba(254, 226, 226, 0.8)",
            color: winningAction === "continue" ? "#047857" : "#b91c1c",
            borderRadius: "8px",
            textAlign: "center",
            fontWeight: "bold",
            fontSize: "1.1em",
            marginBottom: "12px",
            border: `1px solid ${winningAction === "continue" ? "rgba(34, 197, 94, 0.3)" : "rgba(220, 38, 38, 0.3)"}`
          }}
        >
          Team has decided to {winningAction === "continue" ? "CONTINUE GUESSING" : "END TURN"}
        </div>
      ) : (
        <>
        {/* Continue Option */}
        <div
          onClick={() => !allOperativesVoted && handleVote("continue")}
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
            cursor: allOperativesVoted ? "default" : "pointer",
            position: "relative",
            overflow: "hidden",
            opacity: allOperativesVoted ? 0.7 : 1
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
        onClick={() => !allOperativesVoted && handleVote("end_turn")}
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
          cursor: allOperativesVoted ? "default" : "pointer",
          position: "relative",
          overflow: "hidden",
          opacity: allOperativesVoted ? 0.7 : 1
        }}>
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
      </>
      )}

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
