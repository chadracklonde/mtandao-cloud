import { IsEmail, IsIn, IsString } from 'class-validator';

export class CreateInvitationDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsIn(['admin', 'manager', 'seller', 'technician', 'viewer'])
  role!: 'admin' | 'manager' | 'seller' | 'technician' | 'viewer';
}
