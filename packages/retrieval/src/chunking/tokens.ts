export interface TokenCounter {
  countTokens(text: string): Promise<number>;
}

/** ~4 characters per token: good enough for chunk sizing, no tokenizer download. */
export class ApproxTokenCounter implements TokenCounter {
  countTokens(text: string): Promise<number> {
    return Promise.resolve(Math.ceil(text.length / 4));
  }
}
