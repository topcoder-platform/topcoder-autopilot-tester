declare namespace Express {
  interface Request {
    user?: {
      handle: string;
      userId: number;
      roles?: string[];
      token: string;
    };
  }
}
