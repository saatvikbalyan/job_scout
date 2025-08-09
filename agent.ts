import dotenv from "dotenv";
dotenv.config();
import { Langbase } from "langbase";

// Tool schema for web search
const webSearchToolSchema = {
  "type": "function" as const,
  "function": {
    "name": "search_jobs",
    "description": "Search for job listings on popular job websites",
    "parameters": {
      "type": "object",
      "required": ["keywords"],
      "properties": {
        "keywords": {
          "type": "string",
          "description": "Job search keywords (e.g., 'software engineer', 'data scientist')"
        },
        "location": {
          "type": "string",
          "description": "Job location (optional)"
        }
      },
      "additionalProperties": false
    },
    "strict": true
  }
};

// Tool implementation
async function search_jobs(keywords: string, location?: string) {
  const langbase = new Langbase({
    apiKey: process.env.LANGBASE_API_KEY!,
  });

  const jobSites = [
    "site:greenhouse.io",
    "site:linkedin.com/jobs",
    "site:indeed.com",
    "site:glassdoor.com",
    "site:monster.com",
    "site:ziprecruiter.com",
    "site:careerbuilder.com"
  ];

  let allResults = [];

  for (const site of jobSites) {
    try {
      const searchQuery = location 
        ? `${keywords} ${location} ${site} "open positions" OR "now hiring" OR "apply now"`
        : `${keywords} ${site} "open positions" OR "now hiring" OR "apply now"`;

      const results = await langbase.tools.webSearch({
        service: 'exa',
        query: searchQuery,
        totalResults: 5,
        apiKey: process.env.EXA_API_KEY!
      });

      allResults.push(...results.map(result => ({
        ...result,
        source: site.replace('site:', ''),
        keywords: keywords,
        location: location || 'Not specified'
      })));
    } catch (error) {
      console.error(`Error searching ${site}:`, error);
    }
  }

  return JSON.stringify(allResults);
}

async function jobScrapingWorkflow({ input, env }) {
  const langbase = new Langbase({
    apiKey: process.env.LANGBASE_API_KEY!,
  });

  const workflow = langbase.workflow();
  const { step } = workflow;

  try {
    let inputMessages = [
      { role: "user", content: input },
    ];

    const response = await step({
      id: "analyze_job_request",
      run: async () => {
        return await langbase.agent.run({
          model: "openai:gpt-5-mini-2025-08-07",
          apiKey: process.env.OPENAI_API_KEY!,
          instructions: "You are a job search assistant. Extract job search keywords and location from user input. Use the search_jobs tool to find relevant job listings.",
          input: inputMessages,
          tools: [webSearchToolSchema],
          stream: false,
        });
      },
    });

    // Push the tool call to the messages thread
    inputMessages.push(response.choices[0].message);

    // Parse the tool call
    const toolCalls = response.choices[0].message.tool_calls;
    const hasToolCalls = toolCalls && toolCalls.length > 0;

    if (hasToolCalls) {
      const jobResults = await step({
        id: "search_job_listings",
        run: async () => {
          let allJobResults = [];
          
          for (const toolCall of toolCalls) {
            const { name, arguments: args } = toolCall.function;
            const parsedArgs = JSON.parse(args);
            
            if (name === 'search_jobs') {
              const result = await search_jobs(parsedArgs.keywords, parsedArgs.location);
              allJobResults.push(result);
              
              inputMessages.push({
                name,
                tool_call_id: toolCall.id,
                role: 'tool',
                content: result,
              });
            }
          }
          
          return allJobResults;
        },
      });

      const finalResponse = await step({
        id: "format_job_results",
        run: async () => {
          const { output } = await langbase.agent.run({
            model: "openai:gpt-5-mini-2025-08-07",
            apiKey: process.env.OPENAI_API_KEY!,
            instructions: `You are a job search assistant. Format the job search results in a clear, organized manner. 

            For each job listing, include:
            - Job title (if available)
            - Company name
            - Location
            - Source website
            - Brief description
            - Application link

            Group results by website (Greenhouse, LinkedIn, Indeed, etc.) and provide a summary of total jobs found.
            
            If no jobs are found, suggest alternative search terms or broader keywords.`,
            input: inputMessages,
            stream: false,
          });
          return output;
        },
      });

      return finalResponse;
    } else {
      const directResponse = await step({
        id: "direct_response",
        run: async () => {
          const { output } = await langbase.agent.run({
            model: "openai:gpt-5-mini-2025-08-07",
            apiKey: process.env.OPENAI_API_KEY!,
            instructions: "You are a job search assistant. Help the user refine their job search query. Ask for specific job titles, skills, or locations they're interested in.",
            input: inputMessages,
            stream: false,
          });
          return output;
        },
      });

      return directResponse;
    }

  } catch (err) {
    console.error("Workflow error:", err);
    throw err;
  } finally {
    await workflow.end();
  }
}

async function main(event, env) {
  const { input } = await event.json();
  const result = await jobScrapingWorkflow({ input, env });
  return result;
}

export default main;

(async () => {
  const event = {
    json: async () => ({
      input: 'Your input goes here.',
    }),
  };
  const result = await main(event, {});
  console.log(result);
})();