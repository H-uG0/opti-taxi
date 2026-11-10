import "server-only";
import { NextResponse } from "next/server";

/** JSON answer of a driver route handler: never stored by the browser or a proxy (it can carry a session renewal). */
export function jsonReply<T>(status: number, body: T): NextResponse<T> {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export const SESSION_ERROR = "Session expirée\u00a0: reconnectez-vous. Les statuts saisis restent gardés sur le téléphone.";
export const PASSWORD_ERROR = "Choisissez d'abord votre mot de passe. Les statuts saisis restent gardés sur le téléphone.";
export const ORIGIN_ERROR = "Requête refusée (autre site).";
