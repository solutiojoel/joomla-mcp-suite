import fs from "node:fs/promises";
import path from "node:path";

export interface SubAgentConfig {
  name: string;
  model?: string;
  allow: string[];
  downstreams: string[];
  instructions: string;
}

export async function loadSubAgentConfig(name: string): Promise<SubAgentConfig> {
  const configDir = path.join(__dirname, "..", "..", "..", "config", "agents", name);
  const jsonPath = path.join(configDir, `${name}.json`);
  
  let def: any;
  try {
    const raw = await fs.readFile(jsonPath, "utf8");
    def = JSON.parse(raw);
  } catch (error: any) {
    throw new Error(`Failed to load config for sub-agent '${name}': ${error.message}`);
  }

  const instructionsFilename = def.instructions || `${name}.md`;
  const instructionsPath = path.join(configDir, instructionsFilename);
  
  let instructions = "";
  try {
    instructions = await fs.readFile(instructionsPath, "utf8");
  } catch (error: any) {
    throw new Error(`Failed to load instructions for sub-agent '${name}': ${error.message}`);
  }

  return {
    name: def.name || name,
    model: def.model,
    allow: def.tools?.allow || [],
    downstreams: def.tools?.downstreams || [],
    instructions,
  };
}
