import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

@Injectable()
export class InvitationsService {
  private async callRpc<T>(
    functionName: string,
    payload: Record<string, string>,
    accessToken: string,
  ): Promise<T> {
    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      throw new ServiceUnavailableException('Supabase is not configured');
    }

    let response: Response;
    try {
      response = await fetch(`${supabaseUrl}/rest/v1/rpc/${functionName}`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ServiceUnavailableException('Supabase is unavailable');
    }

    if (response.status === 401 || response.status === 403) {
      throw new BadGatewayException('Supabase rejected the invitation operation');
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new BadGatewayException(`Invitation operation failed: ${detail || response.statusText}`);
    }
    return (await response.json()) as T;
  }

  async create(
    siteId: string,
    email: string,
    role: string,
    accessToken: string,
  ): Promise<{ invitationId: string }> {
    const id = await this.callRpc<string>(
      'create_site_invitation',
      { p_site_id: siteId, p_email: email, p_role: role },
      accessToken,
    );
    if (typeof id !== 'string') {
      throw new BadGatewayException('Supabase returned an invalid invitation identifier');
    }
    return { invitationId: id };
  }

  async accept(invitationId: string, accessToken: string): Promise<{ siteId: string }> {
    const siteId = await this.callRpc<string>(
      'accept_site_invitation',
      { p_invitation_id: invitationId },
      accessToken,
    );
    if (typeof siteId !== 'string') {
      throw new BadGatewayException('Supabase returned an invalid site identifier');
    }
    return { siteId };
  }
}
