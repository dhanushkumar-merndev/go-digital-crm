// mailparser ships no types. Only the part the portal inbox worker uses is
// declared; @types/mailparser was left out because its current release is too
// new for the dependency age policy.
declare module 'mailparser' {
  export type ParsedMail = {
    subject?: string;
    text?: string;
    html?: string | false;
    messageId?: string;
    date?: Date;
  };
  export function simpleParser(
    source: Buffer | string,
    options?: {
      skipHtmlToText?: boolean;
      skipImageLinks?: boolean;
      skipTextToHtml?: boolean;
      skipTextLinks?: boolean;
    },
  ): Promise<ParsedMail>;
}
