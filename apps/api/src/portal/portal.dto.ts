import { IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

export class PortalCreatePaymentDto {
  @IsUUID()
  planId!: string;

  @IsUUID()
  routerId!: string;

  @IsString()
  @Matches(/^\+?[0-9]{8,15}$/)
  customerPhone!: string;

  @IsOptional()
  @IsString()
  @Length(8, 200)
  idempotencyKey?: string;
}
