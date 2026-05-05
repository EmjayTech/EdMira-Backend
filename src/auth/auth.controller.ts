import { Body, Controller, Post, UseGuards, HttpCode, HttpStatus, Get, Req, UseInterceptors } from '@nestjs/common';
import { CacheInterceptor, CacheKey, CacheTTL } from '@nestjs/cache-manager';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { GetCurrentUser } from '../common/decorators/get-current-user.decorator';
import { RtGuard } from './jwt/rt.guard';
import { AuthService } from './auth.service';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { ResetPasswordDto } from './dto/rest-password.dto';
import { SignupDto } from './dto/signup.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { Public } from 'src/common/decorators/public.decorator';
import { Request } from 'express';


@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) { }

  @Public()
  @Post('signup')
  @ApiOperation({ summary: 'Register a new user' })
  @ApiResponse({ status: 201, description: 'User successfully registered. OTP sent.' })
  @ApiResponse({ status: 409, description: 'Email already exists.' })
  signup(@Body() signUp: SignupDto) {
    return this.authService.signup(signUp);
  }

  @Public()
  @Post('verify')
  @ApiOperation({ summary: 'Verify email with OTP' })
  @ApiResponse({ status: 201, description: 'Email verified successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid or expired OTP.' })
  verify(@Body() otp: VerifyOtpDto) {
    return this.authService.verifyOtp(otp);
  }

  @Public()
  @Post('resend-otp')
  @ApiOperation({ summary: 'Resend OTP to email' })
  @ApiResponse({ status: 201, description: 'OTP resent successfully.' })
  resendOtp(@Body() dto: ResendOtpDto) {
    return this.authService.resendOtp(dto);
  }

  @Public()
  @Post('login')
  @ApiOperation({ summary: 'Log in user' })
  @ApiResponse({ status: 200, description: 'Login successful. Returns access and refresh tokens.' })
  @ApiResponse({ status: 401, description: 'Invalid credentials or unverified email.' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('logout')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Log out user' })
  @ApiResponse({ status: 200, description: 'Logout successful.' })
  @HttpCode(HttpStatus.OK)
  logout(@GetCurrentUser('userId') userId: string, @Req() req: Request) {
    // Extract access token for blacklisting
    const accessToken = req.get('Authorization')?.replace(/^Bearer\s+/i, '').trim();
    return this.authService.logout(userId, accessToken);
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'Returns user profile.' })
  @UseInterceptors(CacheInterceptor)
  @CacheKey('user_profile')
  @CacheTTL(300) // 5 minutes
  getProfile(@GetCurrentUser() user: any) {
    return user;
  }

  @Public()
  @UseGuards(RtGuard)
  @Post('refresh')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, description: 'Tokens refreshed.' })
  @HttpCode(HttpStatus.OK)
  refreshTokens(
    @GetCurrentUser('userId') userId: string,
    @GetCurrentUser('refreshToken') refreshToken: string,
  ) {
    return this.authService.refreshTokens(userId, refreshToken);
  }

  @Public()
  @Post('forgot-password')
  @ApiOperation({ summary: 'Request password reset' })
  @ApiResponse({ status: 201, description: 'Reset code sent.' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Public()
  @Post('reset-password')
  @ApiOperation({ summary: 'Reset password' })
  @ApiResponse({ status: 200, description: 'Password reset successful.' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }
}