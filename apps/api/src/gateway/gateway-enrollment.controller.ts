import { Body, Controller, Post } from '@nestjs/common';
import { IsString, Matches } from 'class-validator';
import { GatewayEnrollmentService } from './gateway-enrollment.service';

class RedeemGatewayEnrollmentDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  enrollmentToken!: string;
}

@Controller('gateway')
export class GatewayEnrollmentController {
  constructor(private readonly enrollmentService: GatewayEnrollmentService) {}

  @Post('enroll')
  redeem(@Body() dto: RedeemGatewayEnrollmentDto) {
    return this.enrollmentService.redeem(dto.enrollmentToken);
  }
}
