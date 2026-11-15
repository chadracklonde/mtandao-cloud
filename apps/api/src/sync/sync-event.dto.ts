import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class SyncEventDto {
  @IsUUID() id!: string;
  @IsUUID() site_id!: string;
  @IsUUID() device_id!: string;
  @IsOptional() @IsUUID() router_id?: string | null;
  @IsString() @MaxLength(120) event_type!: string;
  @IsInt() @Min(1) schema_version!: number;
  @IsDateString() occurred_at!: string;
  @IsObject() payload!: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(200) idempotency_key?: string;
}

export class SyncEventsBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SyncEventDto)
  events!: SyncEventDto[];
}
