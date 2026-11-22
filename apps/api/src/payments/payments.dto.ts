import { IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

export class CreatePaymentDto {
  @IsUUID()
  planId!: string;

  @IsUUID()
  routerId!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{8,15}$/)
  customerPhone?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  idempotencyKey?: string;
}
