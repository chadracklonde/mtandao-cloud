import {
  IsBoolean,
  Matches,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const GATEWAY_OPERATIONS = [
  'health.check',
  'hotspot.voucher.create',
  'hotspot.voucher.disable',
  'hotspot.profile.list',
  'hotspot.active-sessions.list',
] as const;
export type GatewayOperation = (typeof GATEWAY_OPERATIONS)[number];

export class CreateGatewayCommandDto {
  @IsIn(GATEWAY_OPERATIONS as unknown as string[])
  operation!: GatewayOperation;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(3600)
  ttlSeconds?: number;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  idempotencyKey?: string;
}

export class ClaimCommandsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class CommandResultDto {
  @IsBoolean()
  success!: boolean;

  @IsOptional()
  @IsObject()
  result?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  error?: string;
}

export class CommandRouterQuery {
  @IsOptional()
  @IsUUID()
  routerId?: string;
}

export class CreateVoucherDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_.-]{1,64}$/)
  code!: string;

  /** Takes the usage time limit, data limit and Hotspot profile from this plan. */
  @IsOptional()
  @IsUUID()
  planId?: string;

  /** Usage time limit in minutes (RouterOS limit-uptime). Overrides the plan's. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(525600)
  usageLimitMinutes?: number;

  /** Explicitly no time limit. Cannot be combined with usageLimitMinutes. */
  @IsOptional()
  @IsBoolean()
  unlimited?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  dataLimitMb?: number;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9 _.-]{1,120}$/)
  profile?: string;

  /** Free note appended to the ticket comment (letters, digits, space, dot, dash; 30 max). */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9 .'-]{1,30}$/)
  note?: string;
}
