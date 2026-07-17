import type { FastifyReply } from "fastify";

/** OpenAI-format error envelope (IMPLEMENTATION_GUIDE.md §3.6). */
export interface OpenAIErrorResponse {
	error: {
		message: string;
		type: string;
		code: string;
	};
}

export function openAIError(
	message: string,
	code: string,
	type = "invalid_request_error",
): OpenAIErrorResponse {
	return {
		error: {
			message,
			type,
			code,
		},
	};
}

export function sendError(
	reply: FastifyReply,
	statusCode: number,
	message: string,
	code: string,
	type = "invalid_request_error",
): FastifyReply {
	return reply.code(statusCode).send(openAIError(message, code, type));
}
