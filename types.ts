
export enum Difficulty {
  SLOW = 'slow',
  NORMAL = 'normal',
  FAST = 'fast'
}

export interface SessionStats {
  turns: number;
  words: number;
  startTime: Date;
  feedbackCount: number;
}

export interface Scenario {
  id: string;
  title: string;
  topic: string;
  prompt: string;
  icon: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: Date;
}
