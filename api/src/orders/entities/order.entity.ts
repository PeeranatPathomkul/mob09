import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

export enum OrderStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
}

@Entity('orders')
@Unique(['userId', 'productId'])
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @Column({ name: 'product_id' })
  productId!: string;

  @Column({ type: 'int', default: 1 })
  quantity!: number;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PENDING })
  status!: OrderStatus;

  /**
   * Which BullMQ job created this row.
   *
   * This is what makes a 23505 unique violation readable: if the existing
   * row carries the same job_id we are currently running, this job already
   * committed and is simply being replayed after a crash — not a second
   * purchase attempt. Nullable so rows written before this column existed
   * (and any future non-queue writer) stay valid.
   */
  @Column({ name: 'job_id', type: 'varchar', nullable: true })
  jobId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
