import { IsIn, IsString, Length, Matches, MaxLength } from 'class-validator';

export class CreateSiteDto {
  @IsString()
  @Length(2, 120)
  name!: string;

  @IsIn(['CDF', 'USD'])
  defaultCurrency: 'CDF' | 'USD' = 'CDF';

  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z_]+\\/[A-Za-z_]+(?:\\/[A-Za-z_]+)?$/)
  timezone = 'Africa/Lubumbashi';
}
