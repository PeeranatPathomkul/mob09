import { Check, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('products')
@Check('remaining_stock >= 0')
export class Product {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column('decimal', { precision: 10, scale: 2 })
  price: string;

  @Column({ name: 'total_stock', type: 'int' })
  totalStock: number;

  @Column({ name: 'remaining_stock', type: 'int' })
  remainingStock: number;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
