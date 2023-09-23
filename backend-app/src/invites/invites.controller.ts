import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { InvitesService } from './invites.service';
import { InviteEntity } from './entities/Invite.entity';
import { sendInviteDto } from './dtos/sendInvite.dto';
import { createInviteDto } from './dtos/createInvite.dto';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { DeleteResult } from 'typeorm';

@UseGuards(JwtAuthGuard)
@Controller('invites')
@ApiTags('invites')
export class InvitesController {
  constructor(private inviteService: InvitesService) {}

  @Get(':id')
  @ApiOkResponse({ type: sendInviteDto, description: 'Get invite by ID.' })
  @ApiBadRequestResponse({ description: 'Bad request.' })
  getInviteByID(@Param('id', ParseIntPipe) id: number): Promise<sendInviteDto> {
    return this.inviteService.fetchInviteByID(id);
  }

  @Get('/sender/:id')
  @ApiOkResponse({
    type: sendInviteDto,
    isArray: true,
    description: 'Get invite by sender username.',
  })
  @ApiBadRequestResponse({ description: 'Bad request.' })
  getInvitesBySenderUsername(
    @Param('id', ParseIntPipe) userID: number,
  ): Promise<sendInviteDto[]> {
    return this.inviteService.fetchInvitesBySenderID(userID);
  }

  @Get('/received/:id')
  @ApiOkResponse({
    type: sendInviteDto,
    isArray: true,
    description: 'Get invite by invited user username.',
  })
  @ApiBadRequestResponse({ description: 'Bad request.' })
  getInvitesByInvitedUsername(
    @Param('id', ParseIntPipe) userID: number,
  ): Promise<sendInviteDto[]> {
    return this.inviteService.fetchInvitesByInvitedID(userID);
  }

  @Get()
  @ApiOkResponse({
    type: sendInviteDto,
    isArray: true,
    description: 'Get all invites.',
  })
  getAllInvites(): Promise<sendInviteDto[]> {
    return this.inviteService.fetchAllInvites();
  }

  @Post()
  @ApiCreatedResponse({ type: sendInviteDto, description: 'Record created.' })
  @ApiBadRequestResponse({ description: 'Bad request.' })
  @ApiUnprocessableEntityResponse({
    description: 'Database error. (Unprocessable entity)',
  })
  createInvite(@Body() inviteDto: createInviteDto): Promise<sendInviteDto> {
    return this.inviteService.createInvite(inviteDto);
  }

  @Delete(':id')
  @ApiOkResponse({ description: 'Record deleted by ID.' })
  @ApiBadRequestResponse({ description: 'Bad request' })
  @ApiUnprocessableEntityResponse({
    description: 'Database error. (Unprocessable entity)',
  })
  deleteInviteByID(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DeleteResult> {
    return this.inviteService.deleteInviteByID(id);
  }
}
