import { createClarit } from '../src/index.js';
import { generateText } from 'ai';

/**
 * Basic Chat Example
 * 
 * Shows how to use Clarit as a drop-in OpenAI-compatible provider
 * for standard stateless chat.
 */
async function main() {
  const clarit = createClarit({
    baseURL: process.env.CLARIT_BASE_URL ?? 'http://localhost:30000',
    apiKey: process.env.CLARIT_API_KEY,
  });

  console.log('Sending standard chat request...');

  const { text } = await generateText({
    model: clarit('granite-4.0-h-small'),
    messages: [
      { role: 'user', content: 'What is the capital of France?' },
    ],
  });

  console.log('Response:', text);
}

main().catch(console.error);
