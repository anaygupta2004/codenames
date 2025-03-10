"use client"

import { useState } from "react"
import { Plus, Minus, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { useLocation } from "wouter"
import { SiOpenai, SiAnthropic, SiGooglegemini, SiX } from "react-icons/si"
import { Bot } from "lucide-react"
import { toast } from "@/hooks/use-toast"
import { createInitialGame } from "@/lib/game"
import { motion } from "framer-motion"

// AI models available in the game
const AI_MODELS = [
  { id: "gpt-4o", name: "GPT-4o", icon: SiOpenai, type: "advanced" },
  { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5", icon: SiAnthropic, type: "advanced" },
  { id: "grok-2-1212", name: "Grok 2", icon: SiX, type: "advanced" },
  { id: "gemini-1.5-pro", name: "Gemini Pro", icon: SiGooglegemini, type: "advanced" },
  { id: "human-player", name: "Human Player", icon: "👤", type: "human" },
]

type TeamMember = {
  id: string
  role: string
  modelId: string
}

type Team = {
  name: string
  color: string
  members: TeamMember[]
}

export default function HomePage() {
  const [teams, setTeams] = useState<Team[]>([
    {
      name: "Red Team",
      color: "red",
      members: [
        { id: "red-spymaster", role: "Spymaster", modelId: "gpt-4o" },
        { id: "red-operative-1", role: "Operative 1", modelId: "claude-3-5-sonnet-20241022" },
        { id: "red-operative-2", role: "Operative 2", modelId: "human-player" },
      ],
    },
    {
      name: "Blue Team",
      color: "blue",
      members: [
        { id: "blue-spymaster", role: "Spymaster", modelId: "claude-3-5-sonnet-20241022" },
        { id: "blue-operative-1", role: "Operative 1", modelId: "grok-2-1212" },
        { id: "blue-operative-2", role: "Operative 2", modelId: "human-player" },
      ],
    },
  ])

  const [searchQuery, setSearchQuery] = useState("")
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(false)
  const [_, navigate] = useLocation()

  // Filter AI models based on search query
  const filteredModels = AI_MODELS.filter((model) => 
    model.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  // Add a new team member
  const addTeamMember = (teamIndex: number) => {
    const updatedTeams = [...teams]
    const team = updatedTeams[teamIndex]
    const operativeCount = team.members.filter((m) => m.role.includes("Operative")).length

    team.members.push({
      id: `${team.color.toLowerCase()}-operative-${operativeCount + 1}`,
      role: `Operative ${operativeCount + 1}`,
      modelId: "human-player",
    })

    setTeams(updatedTeams)
  }

  // Remove a team member
  const removeTeamMember = (teamIndex: number, memberIndex: number) => {
    if (teams[teamIndex].members.length <= 2) return // Keep at least 2 members

    const updatedTeams = [...teams]
    updatedTeams[teamIndex].members.splice(memberIndex, 1)

    // Rename operatives to maintain sequential numbering
    const operatives = updatedTeams[teamIndex].members.filter((m) => m.role.includes("Operative"))
    operatives.forEach((member, idx) => {
      member.role = `Operative ${idx + 1}`
      member.id = `${updatedTeams[teamIndex].color.toLowerCase()}-operative-${idx + 1}`
    })

    setTeams(updatedTeams)
  }

  // Update team member model
  const updateTeamMember = (teamIndex: number, memberIndex: number, modelId: string) => {
    const updatedTeams = [...teams]
    updatedTeams[teamIndex].members[memberIndex].modelId = modelId
    setTeams(updatedTeams)
  }

  // Get model details by ID
  const getModelById = (modelId: string) => {
    return AI_MODELS.find((model) => model.id === modelId) || 
      { name: "Select Model", icon: "❓", type: "unknown" }
  }

  // Render model icon based on ID
  const renderModelIcon = (modelId: string) => {
    const model = getModelById(modelId);
    const IconComponent = model.icon;
    
    if (typeof IconComponent === "string") {
      return <span>{IconComponent}</span>;
    }
    
    return <IconComponent className="h-5 w-5" />;
  };

  // Start a new game
  const startGame = async () => {
    setLoading(true);
    
    try {
      // Convert team data to the format expected by createInitialGame
      const redTeam = teams[0].members;
      const blueTeam = teams[1].members;
      
      // Format team configurations as arrays
      const redTeamConfig = [
        redTeam.find(m => m.role === "Spymaster")?.modelId || "gpt-4o",
        ...redTeam.filter(m => m.role.includes("Operative")).map(m => m.modelId)
      ];
      
      const blueTeamConfig = [
        blueTeam.find(m => m.role === "Spymaster")?.modelId || "claude-3-5-sonnet-20241022",
        ...blueTeam.filter(m => m.role.includes("Operative")).map(m => m.modelId)
      ];
      
      // Call with the correct parameters - two separate arrays
      const gameData = createInitialGame(redTeamConfig, blueTeamConfig);
      
      console.log("Creating game with data:", gameData);
      
      const response = await fetch('/api/games', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(gameData)
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to create game");
      }
      
      const result = await response.json();
      console.log("Game created:", result);
      
      if (result && result.id) {
        navigate(`/game/${result.id}`);
      } else {
        throw new Error("No game ID returned");
      }
    } catch (error: any) {
      console.error("Error creating game:", error);
      toast({
        title: "Failed to create game",
        description: error.message || "There was an error creating the game. Please try again.",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-800 flex flex-col items-center justify-center p-4">
      <Card className="w-full max-w-4xl bg-white/95 backdrop-blur shadow-xl">
        <CardHeader className="text-center border-b pb-6">
          <motion.div
            className="text-4xl font-bold relative py-1"
            initial={{ backgroundPosition: "0% 50%" }}
            animate={{ 
              backgroundPosition: ["0% 50%", "100% 50%", "0% 50%"]
            }}
            transition={{ 
              duration: 15, 
              repeat: Infinity,
              ease: "linear"
            }}
            style={{
              backgroundSize: "400% 100%",
              backgroundImage: "linear-gradient(90deg, #3b82f6, #ef4444, #3b82f6)",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent"
            }}
          >
            Codenames AI
          </motion.div>
          <CardDescription className="text-lg mt-2">Choose your AI teammates and start playing!</CardDescription>
        </CardHeader>

        <CardContent className="pt-6 space-y-8">
          {teams.map((team, teamIndex) => (
            <div key={team.name} className="space-y-4">
              <div className="flex items-center gap-2">
                <div className={cn("w-3 h-3 rounded-full", team.color === "red" ? "bg-red-500" : "bg-blue-500")} />
                <h2 className={cn("text-xl font-bold", team.color === "red" ? "text-red-600" : "text-blue-600")}>
                  {team.name}
                </h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {team.members.map((member, memberIndex) => {
                  const model = getModelById(member.modelId)

                  return (
                    <div key={member.id} className="flex items-center gap-2">
                      <div className="flex-1">
                        <p className="text-sm font-medium text-gray-700 mb-1">{member.role}</p>
                        <Popover
                          open={open[member.id]}
                          onOpenChange={(isOpen) => setOpen({ ...open, [member.id]: isOpen })}
                        >
                          <PopoverTrigger asChild>
                            <Button variant="outline" role="combobox" className="w-full justify-between">
                              <span className="flex items-center gap-2 truncate">
                                {renderModelIcon(member.modelId)}
                                <span>{model.name}</span>
                              </span>
                              <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-[250px] p-0">
                            <Command>
                              <CommandInput
                                placeholder="Search models..."
                                onValueChange={setSearchQuery}
                                className="h-9"
                              />
                              <CommandList>
                                <CommandEmpty>No model found.</CommandEmpty>
                                <CommandGroup>
                                  {filteredModels.map((model) => (
                                    <CommandItem
                                      key={model.id}
                                      value={model.id}
                                      onSelect={() => {
                                        updateTeamMember(teamIndex, memberIndex, model.id)
                                        setOpen({ ...open, [member.id]: false })
                                      }}
                                    >
                                      {typeof model.icon === "string" ? (
                                        <span className="mr-2">{model.icon}</span>
                                      ) : (
                                        <model.icon className="mr-2 h-4 w-4" />
                                      )}
                                      <span>{model.name}</span>
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              </CommandList>
                            </Command>
                          </PopoverContent>
                        </Popover>
                      </div>

                      {member.role !== "Spymaster" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeTeamMember(teamIndex, memberIndex)}
                          className="flex-shrink-0"
                          title="Remove member"
                        >
                          <Minus className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={() => addTeamMember(teamIndex)}
                className={cn(
                  "mt-2",
                  team.color === "red" ? "text-red-600 hover:text-red-700" : "text-blue-600 hover:text-blue-700",
                )}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Operative
              </Button>
            </div>
          ))}
        </CardContent>

        <CardFooter className="flex justify-center pt-2 pb-6">
          <Button
            size="lg"
            className="w-full max-w-xs text-lg font-medium bg-gradient-to-r from-blue-600 to-red-600 hover:from-blue-700 hover:to-red-700 transition-all"
            onClick={startGame}
            disabled={loading}
          >
            {loading ? "Creating Game..." : "Start Game"}
          </Button>
        </CardFooter>
      </Card>

      <p className="text-white/70 text-sm mt-4">Choose your team composition and AI models to begin</p>
    </div>
  )
}