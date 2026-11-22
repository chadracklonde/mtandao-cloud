import {
  IsBoolean,
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
