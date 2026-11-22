import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class CreatePlanDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000_000)
  price!: number;

  @IsString()
  @IsIn(['CDF', 'USD'])
  currency!: 'CDF' | 'USD';

  @IsInt()
  @Min(1)
  @Max(525_600)
  durationMinutes!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  dataLimitMb?: number;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9 _.-]{1,120}$/)
  hotspotProfile?: string;
}

export class SetPlanActiveDto {
  @IsBoolean()
  active!: boolean;
}

export class ImportTicketStockDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @Length(1, 64, { each: true })
  codes!: string[];
}

export const PRICING_TIERS = ['1h', '2h', '24h', '1w', '1m'] as const;
export type PricingTier = (typeof PRICING_TIERS)[number];

export class SetTierPriceDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000_000)
  price!: number;

  @IsOptional()
  @IsString()
  @IsIn(['CDF', 'USD'])
  currency?: 'CDF' | 'USD';

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  dataLimitMb?: number;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9 _.-]{1,120}$/)
  hotspotProfile?: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;
}
