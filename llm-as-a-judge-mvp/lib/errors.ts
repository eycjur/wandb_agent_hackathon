import { ErrorCode } from "@/lib/contracts/generateEvaluate";

export class AppError extends Error {
  status: number;
  code: ErrorCode;
  exposeMessage: string;

  constructor(
    status: number,
    code: ErrorCode,
    exposeMessage: string,
    detail?: string
  ) {
    super(detail ?? exposeMessage);
    this.status = status;
    this.code = code;
    this.exposeMessage = exposeMessage;
    this.name = "AppError";
  }
}
