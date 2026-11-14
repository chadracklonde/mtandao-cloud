import { IsIn, IsString, Length, MaxLength } from 'class-validator';

export class CreateSiteDto {
  @IsString()
  @Length(2, 120)
  name!: string;

  @IsIn(['CDF', 'USD'])
  defaultCurrency: 'CDF' | 'USD' = 'CDF';

  @IsString()
  @MaxLength(64)
  timezone = 'Africa/Lubumbashi';
}
