import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AuthenticatedRequest } from './auth.types';

export function readBearerToken(header?: string): string | null {
  if (!header) return null;
  const match = /^Bearer\\s+([^\\s]+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readBearerToken(request.headers.authorization);
    if (!token) throw new UnauthorizedException('Bearer token required');

    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\\/$/, '');
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      throw new ServiceUnavailableException('Authentication service is not configured');
    }

    let response: Response;
    try {
      response = await fetch(`${supabaseUrl}/auth/v1/user`, {
        method: 'GET',
        headers: {
          apikey: anonKey,
          authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new ServiceUnavailableException('Authentication service is unavailable');
    }

    if (response.status === 401 || response.status === 403) {
      throw new UnauthorizedException('Invalid or expired access token');
    }
    if (!response.ok) {
      throw new ServiceUnavailableException('Unable to verify access token');
    }

    const user = (await response.json()) as { id?: unknown; email?: unknown };
    if (typeof user.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(user.id)) {
      throw new UnauthorizedException('Authentication service returned an invalid user');
    }

    request.user = {
      id: user.id,
      ...(typeof user.email === 'string' ? { email: user.email } : {}),
    };
    return true;
  }
}
