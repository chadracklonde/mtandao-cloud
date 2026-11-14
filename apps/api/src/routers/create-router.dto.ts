import { IsIn, IsString, Length, MaxLength } from 'class-validator';

export class CreateRouterDto {
  @IsString()
  @Length(2, 120)
  name!: string;

  @IsString()
  @Length(2, 128)
  routerIdentity!: string;

  @IsString()
  @IsIn(['android', 'linux'])
  gatewayKind!: 'android' | 'linux';
}
